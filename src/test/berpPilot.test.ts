import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    BERP_MICRO_MAP,
    BERP_PILOT_TASK,
    parseResearchContract,
    runBerpPilot,
    validateResearchContract,
    type BerpPilotDependencies,
    type ResearchContract
} from '../agent/berpPilot.js';
import {
    MAX_REQUEST_BYTES,
    RequestTooLargeError,
    runReadOnlyPrompt,
    type ReadOnlyPromptContext,
    type ToolEvidence
} from '../agent/readOnlyAgent.js';
import { formatPlanResponse } from '../agent/planChange.js';
import { CHAT_MODES, ChatSession } from '../chat/chatSession.js';
import { getChatHtml, handleChatMessage, runChatBerp } from '../chat/chatView.js';

suite('BERP-0 Pilot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-berp-'));
    const workspace = vscode.Uri.file(root);
    const firstPath = BERP_MICRO_MAP[0].path;
    const secondPath = BERP_MICRO_MAP[1].path;
    const plan = [
        '1. Ziel der Änderung',
        'Die Bereichsgrenze wird angepasst.',
        '2. betroffene Dateien, nur soweit tatsächlich geprüft',
        `- ${firstPath}`,
        `- ${secondPath}`,
        '3. höchstens drei Umsetzungsschritte',
        `1. ${firstPath} und ${secondPath} prüfen.`,
        '4. nötige Tests',
        'Den passenden Grenztest ausführen.',
        '5. offene Fragen oder unbelegte Annahmen',
        'Keine'
    ].join('\n');

    fs.mkdirSync(path.dirname(path.join(root, firstPath)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, secondPath)), { recursive: true });
    fs.writeFileSync(path.join(root, firstPath), 'export const MAX_RANGE_LINES = 120;\n');
    fs.writeFileSync(path.join(root, secondPath), 'assert.strictEqual(MAX_RANGE_LINES, 120);\n');

    suiteTeardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const need = (
        targetFile: string = firstPath,
        searchTerm: string = 'MAX_RANGE_LINES'
    ) => ({
        question: `Wo wird ${searchTerm} verwendet?`,
        targetFile,
        searchTerm,
        reason: 'Relevanz für die festgelegte Grenzänderung.'
    });

    const contract = (...needs: ReturnType<typeof need>[]): ResearchContract => ({
        researchNeeds: needs
    });

    const successfulSearch = (
        targetFile: string,
        searchTerm: string,
        line = 1
    ) => ({
        success: true,
        content: JSON.stringify({
            query: searchTerm,
            hits: [{ path: targetFile, line }],
            emittedHitCount: 1,
            moreHitsAvailable: false
        })
    });

    const successfulRange = (
        targetFile: string,
        text = 'export const MAX_RANGE_LINES = 120;'
    ) => ({
        success: true,
        content: JSON.stringify({
            path: targetFile,
            requestedRange: { firstLine: 1, lastLine: 3 },
            readRange: { firstLine: 1, lastLine: 2 },
            totalLines: 2,
            text
        })
    });

    const contractText = (...needs: ReturnType<typeof need>[]) =>
        JSON.stringify(contract(...needs));

    const promptBytes = (
        context: ReadOnlyPromptContext,
        prompt: string
    ) => Buffer.byteLength(JSON.stringify({
        model: 'test-model',
        stream: false,
        messages: [
            { role: 'system', content: context.systemPrompt },
            { role: 'user', content: prompt }
        ],
        options: { temperature: 0.1, num_ctx: 16384 }
    }), 'utf8');

    const dependencies = (
        answer: string,
        options: {
            search?: BerpPilotDependencies['search'];
            readRange?: BerpPilotDependencies['readRange'];
            onSearch?: () => void;
            onRange?: () => void;
            measure?: BerpPilotDependencies['measure'];
            onRequest?: (prompt: string) => void;
        } = {}
    ): Partial<BerpPilotDependencies> => {
        const context: ReadOnlyPromptContext = { systemPrompt: 'test system' };
        const responses = [answer, plan];
        return {
            createContext: async () => context,
            measure: options.measure ?? promptBytes,
            request: async (requestContext, prompt) => {
                options.onRequest?.(prompt);
                const response = responses.shift();
                if (response === undefined) {
                    throw new Error('Unexpected model request');
                }
                return {
                    answer: response,
                    requestBytes: (options.measure ?? promptBytes)(
                        requestContext,
                        prompt
                    )
                };
            },
            search: async (...args) => {
                options.onSearch?.();
                return options.search
                    ? options.search(...args)
                    : successfulSearch(args[1], args[2]);
            },
            readRange: async (...args) => {
                options.onRange?.();
                return options.readRange
                    ? options.readRange(...args)
                    : successfulRange(args[1]);
            }
        };
    };

    test('nimmt einen gültigen Vertrag mit einem Bedürfnis an', () => {
        assert.strictEqual(
            validateResearchContract(contract(need()), workspace).researchNeeds.length,
            1
        );
    });

    test('nimmt einen gültigen Vertrag mit zwei Bedürfnissen an', () => {
        assert.strictEqual(
            validateResearchContract(
                contract(need(), need(secondPath, 'MAX_RANGE_LINES')),
                workspace
            ).researchNeeds.length,
            2
        );
    });

    test('weist mehr als zwei Bedürfnisse zurück', () => {
        assert.throws(
            () => validateResearchContract(
                contract(need(), need(secondPath), need(firstPath, 'different')),
                workspace
            ),
            /ein oder zwei/
        );
    });

    test('weist ungültiges JSON und freien Plantext zurück', () => {
        assert.throws(() => parseResearchContract('{bad'), /kein gültiges JSON/);
        assert.throws(
            () => validateResearchContract(
                parseResearchContract('"Hier ist mein Plan."'),
                workspace
            ),
            /erwartete Struktur/
        );
    });

    test('weist eine Zieldatei außerhalb der Micro Map zurück', () => {
        assert.throws(
            () => validateResearchContract(
                contract(need('src/extension.ts')),
                workspace
            ),
            /außerhalb der bestätigten Micro Map/
        );
    });

    test('weist leere und pfadartige Suchbegriffe zurück', () => {
        for (const searchTerm of ['', '   ', 'src/tools/readTools.ts', 'C:\\temp\\file.ts']) {
            assert.throws(
                () => validateResearchContract(contract(need(firstPath, searchTerm)), workspace)
            );
        }
    });

    test('weist doppelte Bedürfnisse zurück', () => {
        assert.throws(
            () => validateResearchContract(contract(need(), need()), workspace),
            /doppelte/
        );
    });

    test('führt vor bestandener Contract-Validierung kein Werkzeug aus', async () => {
        let tools = 0;
        await assert.rejects(
            runBerpPilot(workspace, undefined, undefined, dependencies(
                '{"researchNeeds":[{"question":"x","targetFile":"src/extension.ts","searchTerm":"x","reason":"x"}]}',
                { onSearch: () => tools += 1, onRange: () => tools += 1 }
            )),
            /außerhalb der bestätigten Micro Map/
        );
        assert.strictEqual(tools, 0);
    });

    test('ein Suchlauf ohne Treffer erzeugt keinen Lesebeleg', async () => {
        const result = await runBerpPilot(
            workspace,
            undefined,
            undefined,
            dependencies(contractText(need()), {
                search: async () => ({
                    success: true,
                    content: JSON.stringify({
                        hits: [],
                        emittedHitCount: 0,
                        moreHitsAvailable: false
                    })
                })
            })
        );
        assert.strictEqual(result.evidence.some(e => e.tool === 'read_file_range'), false);
        assert.strictEqual(result.packet.readEvidence.length, 0);
        assert.match(result.packet.openNeeds[0].reason, /Kein Suchtreffer/);
    });

    test('mehrdeutige Treffer werden nicht automatisch gelesen', async () => {
        let rangeCalls = 0;
        const result = await runBerpPilot(
            workspace,
            undefined,
            undefined,
            dependencies(contractText(need()), {
                search: async () => ({
                    success: true,
                    content: JSON.stringify({
                        hits: [
                            { path: firstPath, line: 1 },
                            { path: firstPath, line: 2 }
                        ],
                        emittedHitCount: 2,
                        moreHitsAvailable: false
                    })
                }),
                onRange: () => rangeCalls += 1
            })
        );
        assert.strictEqual(rangeCalls, 0);
        assert.strictEqual(result.packet.readEvidence.length, 0);
        assert.match(result.packet.openNeeds[0].reason, /nicht eindeutig/);
    });

    test('erfolgreich gelesener Bereich wird samt Herkunft ins Packet übernommen', async () => {
        let requested: [number, number] | undefined;
        const result = await runBerpPilot(
            workspace,
            undefined,
            undefined,
            dependencies(contractText(need()), {
                search: async () => successfulSearch(firstPath, 'MAX_RANGE_LINES', 1),
                readRange: async (_workspace, target, first, last) => {
                    requested = [first, last];
                    return successfulRange(
                        target,
                        'export const MAX_RANGE_LINES = 120;'
                    );
                }
            })
        );
        assert.deepStrictEqual(requested, [1, 3]);
        assert.deepStrictEqual(result.packet.readEvidence, [{
            path: firstPath,
            range: { firstLine: 1, lastLine: 2 },
            codeExcerpt: 'export const MAX_RANGE_LINES = 120;',
            origin: {
                question: 'Wo wird MAX_RANGE_LINES verwendet?',
                searchTerm: 'MAX_RANGE_LINES',
                hitLine: 1
            }
        }]);
        assert.strictEqual(
            result.evidence.some(e => e.tool === 'read_file_range' && e.success),
            true
        );
    });

    test('ein Suchtreffer ohne Bereichslesen gelangt nicht als Codebeleg ins Packet', async () => {
        const result = await runBerpPilot(
            workspace,
            undefined,
            undefined,
            dependencies(contractText(need()), {
                search: async () => successfulSearch(firstPath, 'MAX_RANGE_LINES'),
                readRange: async () => ({ success: false, content: 'read failed' })
            })
        );
        assert.deepStrictEqual(result.packet.readEvidence, []);
        assert.strictEqual(result.packet.openNeeds.length, 1);
        assert.strictEqual(
            JSON.stringify(result.packet).includes('"codeExcerpt"'),
            false
        );
    });

    test('bricht bei einer Plananfrage über 32.000 Bytes ohne Request ab', async () => {
        let requests = 0;
        const result = runBerpPilot(
            workspace,
            undefined,
            undefined,
            dependencies(contractText(need()), {
                measure: (context, prompt) => prompt.includes('BERP-0 Evidence Packet')
                    ? MAX_REQUEST_BYTES + 1
                    : promptBytes(context, prompt),
                onRequest: () => requests += 1
            })
        );
        await assert.rejects(result, (error: unknown) =>
            error instanceof RequestTooLargeError
            && error.bytes === MAX_REQUEST_BYTES + 1
        );
        assert.strictEqual(requests, 1);
    });

    test('kürzt übergroße Evidence-Auszüge nicht stillschweigend', async () => {
        const oversizedCode = 'x'.repeat(MAX_REQUEST_BYTES + 100);
        let measuredPrompt = '';
        let requests = 0;
        const execution = runBerpPilot(
            workspace,
            undefined,
            undefined,
            dependencies(contractText(need()), {
                readRange: async (_workspace, target) =>
                    successfulRange(target, oversizedCode),
                measure: (context, prompt) => {
                    if (prompt.includes('BERP-0 Evidence Packet')) {
                        measuredPrompt = prompt;
                    }
                    return promptBytes(context, prompt);
                },
                onRequest: () => requests += 1
            })
        );
        await assert.rejects(execution, RequestTooLargeError);
        assert.ok(measuredPrompt.includes(oversizedCode));
        assert.strictEqual(requests, 1);
    });

    test('der Planprompt ist explizit werkzeugfrei und verwendet die bestätigte Map', async () => {
        let planPrompt = '';
        await runBerpPilot(
            workspace,
            undefined,
            undefined,
            dependencies(contractText(need()), {
                onRequest: prompt => {
                    if (prompt.includes('BERP-0 Evidence Packet')) {
                        planPrompt = prompt;
                    }
                }
            })
        );
        assert.match(planPrompt, /Diese Phase ist werkzeugfrei/);
        for (const file of BERP_MICRO_MAP) {
            assert.ok(planPrompt.includes(file.path));
        }
    });

    test('der werkzeuglose Modellaufruf sendet keine Tooldefinitionen', async () => {
        const originalFetch = globalThis.fetch;
        let sentBody: Record<string, unknown> | undefined;
        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
            sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({
                message: { role: 'assistant', content: 'Antwort' }
            }));
        }) as typeof fetch;
        try {
            await runReadOnlyPrompt({ systemPrompt: 'System' }, 'Nur Text');
        } finally {
            globalThis.fetch = originalFetch;
        }
        assert.ok(sentBody);
        assert.strictEqual(Object.hasOwn(sentBody, 'tools'), false);
    });

    test('bestehende UNGEPRÜFT- und UNBELEGT-Markierungen bleiben wirksam', () => {
        const answer = [
            '1. Ziel der Änderung',
            'Grenze ändern.',
            '2. betroffene Dateien, nur soweit tatsächlich geprüft',
            'Keine',
            '3. höchstens drei Umsetzungsschritte',
            `1. ${firstPath} und MAX_RANGE_LINES() anpassen.`,
            '4. nötige Tests',
            'Grenztest ausführen.',
            '5. offene Fragen oder unbelegte Annahmen',
            'Keine'
        ].join('\n');
        const formatted = formatPlanResponse(
            answer,
            [],
            0,
            BERP_PILOT_TASK
        );
        assert.match(formatted, /\[UNGEPRÜFT: src\/tools\/readTools\.ts/);
        assert.match(formatted, /\[UNBELEGT: MAX_RANGE_LINES\(\)/);
    });

    test('Evidence Packet behält Aufgabe, feste Micro Map und Byteangabe', async () => {
        const result = await runBerpPilot(
            workspace,
            undefined,
            undefined,
            dependencies(contractText(need()))
        );
        assert.strictEqual(result.packet.originalTask, BERP_PILOT_TASK);
        assert.deepStrictEqual(result.packet.microMap, BERP_MICRO_MAP);
        assert.strictEqual(result.packet.planRequestUtf8Bytes, result.planRequestBytes);
        assert.ok(result.planRequestBytes <= MAX_REQUEST_BYTES);
    });

    suite('Recherchevertrag: Antwortverarbeitung', () => {
        const json = '{"researchNeeds":[]}';

        test('akzeptiert reines JSON und JSON in genau einem Codeblock', () => {
            assert.deepStrictEqual(parseResearchContract(`  ${json}\n`), { researchNeeds: [] });
            assert.deepStrictEqual(parseResearchContract('```json\n' + json + '\n```'), { researchNeeds: [] });
            assert.deepStrictEqual(parseResearchContract('```\n' + json + '\n```\n'), { researchNeeds: [] });
        });

        test('weist Text vor oder nach dem JSON und mehrere Objekte zurück', () => {
            for (const answer of [
                `Hier ist der Vertrag:\n${json}`,
                `${json}\nViel Erfolg!`,
                '```json\n' + json + '\n```\nZusatz',
                'Vertrag:\n```json\n' + json + '\n```',
                `${json}${json}`,
                '```json\n{bad\n```',
                ''
            ]) {
                assert.throws(() => parseResearchContract(answer), /kein gültiges JSON/, answer);
            }
        });

        test('der Fehler zeigt einen gekürzten Antwortanfang', () => {
            assert.throws(
                () => parseResearchContract('Plan:\n' + 'x'.repeat(500)),
                (error: Error) => error.message.includes('Antwortanfang: "Plan: xxx')
                    && error.message.length < 400
            );
        });

        test('ein Vertrag im Codeblock durchläuft den Pilot', async () => {
            const result = await runBerpPilot(
                workspace,
                undefined,
                undefined,
                dependencies('```json\n' + contractText(need()) + '\n```')
            );
            assert.strictEqual(result.packet.readEvidence.length, 1);
        });

        test('ein Vertrag mit Zusatztext löst keinen Werkzeugzugriff aus', async () => {
            let tools = 0;
            await assert.rejects(
                runBerpPilot(workspace, undefined, undefined, dependencies(
                    `Gern:\n${contractText(need())}`,
                    { onSearch: () => tools += 1, onRange: () => tools += 1 }
                )),
                /kein gültiges JSON/
            );
            assert.strictEqual(tools, 0);
        });
    });

    suite('Chat-Integration', () => {
        const berpLabel = CHAT_MODES.berp;

        test('der Modus ist im Chatmenü auswählbar und startet ohne Eingabe', () => {
            const html = getChatHtml('berp');
            assert.ok(html.includes(`<option value="berp">${berpLabel}</option>`));
            assert.ok(html.includes("modeSelect.value !== 'berp'"));
        });

        test('Routing: Modus berp ruft den Pilot ohne Werkzeugaktivitäten auf', async () => {
            let receivedMode: string | undefined;
            let receivedQuestion: string | undefined;
            const statuses: string[] = [];
            const session = new ChatSession(
                (question, _history, onStatus, signal, _onToolActivity, mode) => {
                    receivedMode = mode;
                    receivedQuestion = question;
                    return runChatBerp(
                        workspace,
                        onStatus,
                        signal,
                        dependencies(contractText(need()))
                    );
                },
                state => statuses.push(state.status)
            );
            await handleChatMessage(session, { type: 'submit', mode: 'berp', text: '' });

            assert.strictEqual(receivedMode, 'berp');
            assert.strictEqual(receivedQuestion, '');
            assert.deepStrictEqual(session.state.entries.map(e => e.kind), ['user', 'answer']);
            assert.strictEqual(session.state.entries[0].text, `Modus: ${berpLabel}`);
            const answer = session.state.entries[1].text;
            assert.ok(answer.includes('feste Pilotaufgabe'));
            assert.ok(answer.includes('Größe der gesamten Plananfrage:'));
            assert.ok(!answer.includes('Evidence Packet:'));
            assert.ok(answer.includes('Lesebelege: 1 von 1'));
            assert.ok(answer.includes('1. Ziel der Änderung'));
            assert.deepStrictEqual(session.state.activities, []);
            assert.ok(statuses.includes('BERP-0: Recherchevertrag wird angefordert ...'));
            assert.strictEqual(session.state.busy, false);
        });

        test('eine eingegebene Aufgabe wird nicht ausgewertet', async () => {
            const prompts: string[] = [];
            const session = new ChatSession(
                (_question, _history, onStatus, signal) => runChatBerp(
                    workspace,
                    onStatus,
                    signal,
                    dependencies(contractText(need()), { onRequest: prompt => prompts.push(prompt) })
                )
            );
            await handleChatMessage(session, {
                type: 'submit',
                mode: 'berp',
                text: 'IGNORIERTE_EINGABE_XYZ'
            });
            assert.strictEqual(prompts.length, 2);
            assert.ok(prompts.every(prompt => !prompt.includes('IGNORIERTE_EINGABE_XYZ')));
            assert.ok(prompts.every(prompt => prompt.includes('MAX_RANGE_LINES')));
        });

        test('leere Eingabe bleibt in allen anderen Modi wirkungslos', async () => {
            let runs = 0;
            const session = new ChatSession(async () => {
                runs += 1;
                return { answer: 'x', evidence: [], omitted: 0 };
            });
            for (const mode of ['question', 'plan', 'tools']) {
                await handleChatMessage(session, { type: 'submit', mode, text: '  ' });
            }
            assert.strictEqual(runs, 0);
            assert.strictEqual(session.state.entries.length, 0);
        });

        test('Contract-Fehler erscheint als Fehlereintrag ohne Werkzeugzugriff', async () => {
            let tools = 0;
            const session = new ChatSession(
                (_question, _history, onStatus, signal) => runChatBerp(
                    workspace,
                    onStatus,
                    signal,
                    dependencies('Ich plane gleich.', {
                        onSearch: () => tools += 1,
                        onRange: () => tools += 1
                    })
                )
            );
            await handleChatMessage(session, { type: 'submit', mode: 'berp', text: '' });

            const last = session.state.entries.at(-1);
            assert.strictEqual(last?.kind, 'error');
            assert.match(last.text, /kein gültiges JSON; es wurde nicht recherchiert/);
            assert.match(last.text, /Antwortanfang: "Ich plane gleich\."/);
            assert.strictEqual(tools, 0);
            assert.strictEqual(session.state.busy, false);
        });

        test('Budgetfehler erscheint als Grenzeintrag', async () => {
            const session = new ChatSession(
                (_question, _history, onStatus, signal) => runChatBerp(
                    workspace,
                    onStatus,
                    signal,
                    dependencies(contractText(need()), {
                        measure: () => MAX_REQUEST_BYTES + 1
                    })
                )
            );
            await handleChatMessage(session, { type: 'submit', mode: 'berp', text: '' });
            assert.strictEqual(session.state.entries.at(-1)?.kind, 'limit');
        });
    });

    suite('Teilabschluss ohne Lesebeleg', () => {
        const ambiguous = (targetFile: string) => ({
            success: true,
            content: JSON.stringify({
                hits: [
                    { path: targetFile, line: 1 },
                    { path: targetFile, line: 2 }
                ],
                emittedHitCount: 2,
                moreHitsAvailable: false
            })
        });

        test('ohne gelesenen Bereich: kein Plan und keine zweite Modellanfrage', async () => {
            const prompts: string[] = [];
            const result = await runBerpPilot(
                workspace,
                undefined,
                undefined,
                dependencies(contractText(need(), need(secondPath, 'MAX_RANGE_LINES')), {
                    search: async (_workspace, target) => ambiguous(target),
                    onRequest: prompt => prompts.push(prompt)
                })
            );
            assert.strictEqual(prompts.length, 1);
            assert.strictEqual(result.planRequested, false);
            assert.strictEqual(result.planRequestBytes, 0);
            assert.match(result.answer, /TEILABSCHLUSS/);
            assert.ok(!result.answer.includes('1. Ziel der Änderung'));
            assert.ok(!result.answer.includes('UNGEPRÜFT'));
            assert.strictEqual(result.packet.readEvidence.length, 0);
            assert.match(result.summary, /Lesebelege: 0 von 2/);
            assert.ok(result.summary.includes(`- ${firstPath}, Suchbegriff "MAX_RANGE_LINES": Trefferzahl nicht eindeutig`));
            assert.ok(result.summary.includes(`- ${secondPath}, Suchbegriff "MAX_RANGE_LINES"`));
        });

        test('ohne Treffer und bei Lesefehler ebenfalls Teilabschluss mit Grund', async () => {
            const noHit = await runBerpPilot(workspace, undefined, undefined, dependencies(
                contractText(need()),
                {
                    search: async () => ({
                        success: true,
                        content: JSON.stringify({ hits: [], emittedHitCount: 0, moreHitsAvailable: false })
                    })
                }
            ));
            assert.match(noHit.summary, /Kein Suchtreffer/);
            assert.strictEqual(noHit.planRequested, false);

            const readFails = await runBerpPilot(workspace, undefined, undefined, dependencies(
                contractText(need()),
                { readRange: async () => ({ success: false, content: 'read failed' }) }
            ));
            assert.match(readFails.summary, /read failed/);
            assert.strictEqual(readFails.planRequested, false);
            assert.match(readFails.answer, /TEILABSCHLUSS/);
        });

        test('ein gelesener von zwei Bereichen: Plan mit Zusammenfassung der offenen Gründe', async () => {
            const prompts: string[] = [];
            const result = await runBerpPilot(
                workspace,
                undefined,
                undefined,
                dependencies(contractText(need(), need(secondPath, 'MAX_RANGE_LINES')), {
                    search: async (_workspace, target, term) => target === firstPath
                        ? successfulSearch(target, term)
                        : ambiguous(target),
                    onRequest: prompt => prompts.push(prompt)
                })
            );
            assert.strictEqual(prompts.length, 2);
            assert.strictEqual(result.planRequested, true);
            assert.ok(result.planRequestBytes > 0);
            assert.match(result.summary, /Lesebelege: 1 von 2/);
            assert.ok(result.summary.includes(`- ${secondPath}`));
            assert.ok(!result.summary.includes(`- ${firstPath}`));
            assert.ok(result.answer.includes('1. Ziel der Änderung'));
        });

        test('Chat zeigt Teilabschluss ohne Plan- und Größenangabe', async () => {
            const session = new ChatSession(
                (_question, _history, onStatus, signal) => runChatBerp(
                    workspace,
                    onStatus,
                    signal,
                    dependencies(contractText(need()), {
                        search: async (_workspace, target) => ambiguous(target)
                    })
                )
            );
            await handleChatMessage(session, { type: 'submit', mode: 'berp', text: '' });
            const answer = session.state.entries[1].text;
            assert.match(answer, /Lesebelege: 0 von 1 Recherchebedürfnissen\./);
            assert.match(answer, /Trefferzahl nicht eindeutig/);
            assert.match(answer, /Es wurde keine Plananfrage gesendet\./);
            assert.match(answer, /TEILABSCHLUSS/);
            assert.ok(!answer.includes('Größe der gesamten Plananfrage'));
            assert.ok(!answer.includes('Evidence Packet:'));
            assert.deepStrictEqual(session.state.activities, []);
        });

        test('Contract-Prompt verlangt eindeutige Suchbegriffe und reines JSON, ohne feste Begriffe', async () => {
            const prompts: string[] = [];
            await runBerpPilot(workspace, undefined, undefined, dependencies(
                contractText(need()),
                { onRequest: prompt => prompts.push(prompt) }
            ));
            const contractPrompt = prompts[0];
            assert.match(contractPrompt, /eindeutigen, dateispezifischen Begriff/);
            assert.match(contractPrompt, /Deklaration oder Definition/);
            assert.match(contractPrompt, /Vermeide Begriffe, die in vielen Zeilen vorkommen/);
            assert.match(contractPrompt, /ohne Codeblock, ohne Erklärung/);
            assert.ok(!/export const MAX_RANGE_LINES|searchTerm":"MAX_RANGE/.test(contractPrompt));
        });
    });

    suite('Deklarationsauswahl bei mehreren Treffern', () => {
        const DECL = 'export const MAX_RANGE_LINES = 120;';
        const hitsResult = (
            hits: Array<{ path?: string; line: number; text?: string; textTruncated?: boolean }>,
            options: { more?: boolean | 'unknown'; emitted?: number } = {}
        ) => ({
            success: true,
            content: JSON.stringify({
                hits: hits.map(hit => ({ path: firstPath, ...hit })),
                emittedHitCount: options.emitted ?? hits.length,
                moreHitsAvailable: options.more ?? false
            })
        });
        const hit = (line: number, text: string, textTruncated = false) => ({ line, text, textTruncated });
        const around = (target: string, first: number, last: number) => ({
            success: true,
            content: JSON.stringify({
                path: target,
                requestedRange: { firstLine: first, lastLine: last },
                readRange: { firstLine: first, lastLine: last },
                totalLines: 300,
                text: DECL
            })
        });
        const run = async (
            search: Awaited<ReturnType<BerpPilotDependencies['search']>>,
            searchTerm = 'MAX_RANGE_LINES',
            readRange?: BerpPilotDependencies['readRange']
        ) => {
            let rangeCalls = 0;
            const result = await runBerpPilot(workspace, undefined, undefined, dependencies(
                contractText(need(firstPath, searchTerm)),
                {
                    search: async () => search,
                    readRange: async (...args) => readRange
                        ? readRange(...args)
                        : around(args[1], args[2], args[3]),
                    onRange: () => rangeCalls += 1
                }
            ));
            return { result, rangeCalls };
        };
        const usages = [
            hit(256, 'if (end - start + 1 > MAX_RANGE_LINES) {'),
            hit(261, '+ `${MAX_RANGE_LINES} Zeilen. Bitte fordere einen `')
        ];

        test('genau eine Deklaration unter mehreren Treffern wird gelesen', async () => {
            let requested: [number, number] | undefined;
            const { result, rangeCalls } = await run(
                hitsResult([hit(17, DECL), ...usages]),
                'MAX_RANGE_LINES',
                async (_workspace, target, first, last) => {
                    requested = [first, last];
                    return around(target, first, last);
                }
            );
            assert.strictEqual(rangeCalls, 1);
            assert.deepStrictEqual(requested, [15, 19]);
            assert.strictEqual(result.packet.readEvidence.length, 1);
            assert.strictEqual(result.packet.readEvidence[0].origin.hitLine, 17);
            assert.strictEqual(result.packet.openNeeds.length, 0);
            assert.strictEqual(result.planRequested, true);
        });

        test('auch die Deklarationssuche "export const NAME" und "function name(" wählt aus', async () => {
            const withExport = await run(
                hitsResult([hit(17, DECL), ...usages]),
                'export const MAX_RANGE_LINES'
            );
            assert.strictEqual(withExport.rangeCalls, 1);
            const fn = await run(
                hitsResult([
                    hit(10, 'async function readIt(path: string) {'),
                    hit(40, 'return readIt(a);'),
                    hit(41, 'readIt(b);')
                ]),
                'function readIt('
            );
            assert.strictEqual(fn.rangeCalls, 1);
        });

        test('der Treffertext gelangt weder ins Evidence-Protokoll noch ins Packet', async () => {
            const { result } = await run(hitsResult([hit(17, DECL), ...usages]));
            assert.ok(result.evidence.every(entry => (entry.hits ?? [])
                .every(entry2 => Object.keys(entry2).sort().join() === 'line,path')));
            assert.ok(!JSON.stringify(result.packet).includes('Zeilen. Bitte fordere'));
        });

        test('mehrere Deklarationen: nicht lesen', async () => {
            const { result, rangeCalls } = await run(hitsResult([
                hit(17, DECL),
                hit(90, 'const MAX_RANGE_LINES = 5;')
            ]));
            assert.strictEqual(rangeCalls, 0);
            assert.match(result.packet.openNeeds[0].reason, /nicht eindeutig.*2 Deklarationen/);
            assert.strictEqual(result.planRequested, false);
        });

        test('keine Deklaration (Verwendung, Import, Kommentar, ähnlicher Bezeichner): nicht lesen', async () => {
            const { result, rangeCalls } = await run(hitsResult([
                hit(3, 'MAX_RANGE_LINES,'),
                hit(9, '// const MAX_RANGE_LINES = 1;'),
                hit(12, 'const limit = MAX_RANGE_LINES;'),
                hit(15, 'export const MAX_RANGE_LINES_EXTRA = 1;')
            ]));
            assert.strictEqual(rangeCalls, 0);
            assert.match(result.packet.openNeeds[0].reason, /keine Deklaration von MAX_RANGE_LINES/);
        });

        test('Groß-/Kleinschreibung des Bezeichners muss exakt stimmen', async () => {
            const { rangeCalls } = await run(hitsResult([
                hit(17, 'export const max_range_lines = 1;'),
                hit(18, 'x(MAX_RANGE_LINES)')
            ]));
            assert.strictEqual(rangeCalls, 0);
        });

        test('unvollständige Trefferliste: nicht lesen', async () => {
            for (const more of [true, 'unknown'] as const) {
                const { result, rangeCalls } = await run(
                    hitsResult([hit(17, DECL), ...usages], { more })
                );
                assert.strictEqual(rangeCalls, 0);
                assert.match(result.packet.openNeeds[0].reason, /unvollständig/);
            }
            const mismatch = await run(
                hitsResult([hit(17, DECL), ...usages], { emitted: 5 })
            );
            assert.strictEqual(mismatch.rangeCalls, 0);
            assert.match(mismatch.result.packet.openNeeds[0].reason, /stimmt nicht mit der Trefferliste überein/);
        });

        test('fehlender oder abgeschnittener Treffertext: nicht lesen', async () => {
            const truncated = await run(
                hitsResult([hit(17, DECL), hit(256, 'x …[gekürzt]', true)])
            );
            assert.strictEqual(truncated.rangeCalls, 0);
            assert.match(truncated.result.packet.openNeeds[0].reason, /fehlt oder ist abgeschnitten/);
            const missing = await run(hitsResult([{ line: 17 }, hit(256, 'x')]));
            assert.strictEqual(missing.rangeCalls, 0);
            assert.match(missing.result.packet.openNeeds[0].reason, /fehlt oder ist abgeschnitten/);
        });

        test('falscher Pfad in der Trefferliste: nicht lesen', async () => {
            const { result, rangeCalls } = await run(hitsResult([
                hit(17, DECL),
                { path: secondPath, ...hit(256, 'x(MAX_RANGE_LINES)') }
            ]));
            assert.strictEqual(rangeCalls, 0);
            assert.match(result.packet.openNeeds[0].reason, /außerhalb der Zieldatei/);
        });

        test('Suchbegriff ohne eindeutigen Bezeichner bleibt Stop', async () => {
            for (const term of ['MAX_RANGE_LINES = 120', 'range lines', 'MAX_RANGE_LINES;']) {
                const { result, rangeCalls } = await run(
                    hitsResult([hit(17, DECL), ...usages]),
                    term
                );
                assert.strictEqual(rangeCalls, 0, term);
                assert.match(result.packet.openNeeds[0].reason, /weder Bezeichner noch Deklarationssuche/);
            }
        });

        test('gewählte Deklaration ohne erfolgreiches Lesen oder ohne die Zeile im Bereich ergibt keinen Beleg', async () => {
            const failed = await run(
                hitsResult([hit(17, DECL), ...usages]),
                'MAX_RANGE_LINES',
                async () => ({ success: false, content: 'read failed' })
            );
            assert.strictEqual(failed.result.packet.readEvidence.length, 0);
            assert.match(failed.result.packet.openNeeds[0].reason, /read failed/);
            const wrongRange = await run(
                hitsResult([hit(17, DECL), ...usages]),
                'MAX_RANGE_LINES',
                async (_workspace, target) => around(target, 100, 104)
            );
            assert.strictEqual(wrongRange.result.packet.readEvidence.length, 0);
            assert.strictEqual(wrongRange.result.planRequested, false);
        });

        test('echte Suche und Lesung: Deklaration in readTools wird gelesen, Testdatei mit nur Verwendungen bleibt offen', async () => {
            const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-berp-real-'));
            try {
                fs.mkdirSync(path.dirname(path.join(realRoot, firstPath)), { recursive: true });
                fs.mkdirSync(path.dirname(path.join(realRoot, secondPath)), { recursive: true });
                fs.writeFileSync(path.join(realRoot, firstPath), [
                    '// Lesewerkzeuge',
                    "import * as vscode from 'vscode';",
                    '',
                    DECL,
                    'export function limit() { return MAX_RANGE_LINES + 1; }',
                    ''
                ].join('\n'));
                fs.writeFileSync(path.join(realRoot, secondPath), [
                    "import { MAX_RANGE_LINES } from '../tools/readTools.js';",
                    'assert.strictEqual(MAX_RANGE_LINES, 120);',
                    ''
                ].join('\n'));
                const fake = dependencies(
                    contractText(need(), need(secondPath, 'MAX_RANGE_LINES'))
                );
                const result = await runBerpPilot(
                    vscode.Uri.file(realRoot),
                    undefined,
                    undefined,
                    {
                        createContext: fake.createContext,
                        measure: fake.measure,
                        request: fake.request
                    }
                );
                assert.strictEqual(result.packet.readEvidence.length, 1);
                assert.strictEqual(result.packet.readEvidence[0].path, firstPath);
                assert.strictEqual(result.packet.readEvidence[0].origin.hitLine, 4);
                assert.ok(result.packet.readEvidence[0].codeExcerpt.includes(DECL));
                assert.strictEqual(result.packet.openNeeds.length, 1);
                assert.strictEqual(result.packet.openNeeds[0].targetFile, secondPath);
                assert.match(result.packet.openNeeds[0].reason, /keine Deklaration/);
                assert.match(result.summary, /Lesebelege: 1 von 2/);
            } finally {
                fs.rmSync(realRoot, { recursive: true, force: true });
            }
        });
    });

    suite('Belegprüfung: Bezeichner ohne Klammern', () => {
        const file = 'src/tools/readTools.ts';
        const answerWith = (step: string) => [
            '1. Ziel der Änderung',
            'Grenze anpassen.',
            '2. betroffene Dateien, nur soweit tatsächlich geprüft',
            `- ${file}`,
            '3. höchstens drei Umsetzungsschritte',
            step,
            '4. nötige Tests',
            'Grenztest ausführen.',
            '5. offene Fragen oder unbelegte Annahmen',
            'Keine'
        ].join('\n');
        const evidenceWith = (
            lines: number[],
            options: { searchPath?: string; searchOk?: boolean; read?: boolean } = {}
        ): ToolEvidence[] => [
            {
                tool: 'search_text',
                target: `"MAX_RANGE_LINES" in ${file}`,
                success: options.searchOk ?? true,
                query: 'MAX_RANGE_LINES',
                hits: lines.map(line => ({ path: options.searchPath ?? file, line }))
            },
            ...(options.read === false ? [] : [{
                tool: 'read_file_range' as const,
                target: file,
                success: true,
                deliveredRange: { firstLine: 15, lastLine: 19 }
            }])
        ];
        const stepMarked = (step: string, evidence: ToolEvidence[]) =>
            formatPlanResponse(answerWith(step), evidence, 0, '')
                .includes('[UNGEPRÜFT: Stelle in');

        test('Bezeichner aus erfolgreicher Suche mit Treffer im gelesenen Bereich wird zugeordnet', () => {
            assert.strictEqual(
                stepMarked(`1. MAX_RANGE_LINES in ${file} anpassen.`, evidenceWith([17, 256, 261])),
                false
            );
        });

        test('Treffer nur außerhalb des gelesenen Bereichs bleibt UNGEPRÜFT', () => {
            assert.strictEqual(
                stepMarked(`1. MAX_RANGE_LINES in ${file} anpassen.`, evidenceWith([256, 261])),
                true
            );
        });

        test('ausdrücklich genannte Zeile außerhalb des Bereichs wird nicht überstimmt', () => {
            const evidence = evidenceWith([17, 256]);
            assert.strictEqual(
                stepMarked(`1. MAX_RANGE_LINES in ${file}, Zeile 100, anpassen.`, evidence),
                true
            );
            assert.strictEqual(
                stepMarked(`1. MAX_RANGE_LINES in ${file}, Zeile 17, anpassen.`, evidence),
                false
            );
        });

        test('andere, Teil- oder falsch geschriebene Bezeichner werden nicht zugeordnet', () => {
            const evidence = evidenceWith([17]);
            for (const name of ['OTHER_CONSTANT', 'MAX_RANGE_LINES_EXTRA', 'max_range_lines', 'MAX']) {
                assert.strictEqual(
                    stepMarked(`1. ${name} in ${file} anpassen.`, evidence),
                    true,
                    name
                );
            }
        });

        test('Treffer in anderer Datei oder fehlgeschlagene Suche ordnen nicht zu', () => {
            const step = `1. MAX_RANGE_LINES in ${file} anpassen.`;
            assert.strictEqual(
                stepMarked(step, evidenceWith([17], { searchPath: 'src/test/extension.test.ts' })),
                true
            );
            assert.strictEqual(
                stepMarked(step, evidenceWith([17], { searchOk: false })),
                true
            );
        });

        test('Planmodus: Suchtreffer ohne gelesenen Bereich gelten nicht als geprüft', () => {
            const formatted = formatPlanResponse(
                answerWith(`1. MAX_RANGE_LINES in ${file} anpassen.`),
                evidenceWith([17], { read: false }),
                0,
                ''
            );
            assert.match(formatted, /\[UNGEPRÜFT: src\/tools\/readtools\.ts nicht gelesen/i);
            assert.match(formatted, /WARNUNG \(Unbelegte Dateibehauptung\)/);
        });

        test('bestehende Name()-Prüfung bleibt: Symbol ohne Treffer ist UNBELEGT', () => {
            const formatted = formatPlanResponse(
                answerWith(`1. validateRange() in ${file} anpassen.`),
                evidenceWith([17]),
                0,
                ''
            );
            assert.match(formatted, /\[UNBELEGT: validateRange\(\)/);
        });
    });
});
