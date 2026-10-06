'use strict';
// Reine Hilfsfunktionen der Release-Vorbereitung (ohne Seiteneffekte, testbar).
const NAME_VERSION = /("name": "bubble-vscode-agent",\s*"version": ")(\d+\.\d+\.\d+)(")/g;

function bumpPatch(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new Error(`Ungültige Version: ${version}`);
	}
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

// Ersetzt nur die Bubble-Versionsangaben; übrige Formatierung bleibt erhalten.
function setVersion(text, expectedCount, from, to) {
	let count = 0;
	const result = text.replace(NAME_VERSION, (_all, pre, current, post) => {
		count += 1;
		if (current !== from) {
			throw new Error(`Uneinheitliche Version ${current}, erwartet ${from}.`);
		}
		return pre + to + post;
	});
	if (count !== expectedCount) {
		throw new Error(`Erwartet ${expectedCount} Versionsangaben, gefunden ${count}.`);
	}
	return result;
}

// package.json: genau eine Angabe auf oberster Ebene (zwei Leerzeichen/Tab Einzug).
function setPackageVersion(text, from, to) {
	let count = 0;
	const result = text.replace(/^([ \t]{1,2}"version": ")(\d+\.\d+\.\d+)(")/m, (_all, pre, current, post) => {
		count += 1;
		if (current !== from) {
			throw new Error(`Uneinheitliche Version ${current}, erwartet ${from}.`);
		}
		return pre + to + post;
	});
	if (count !== 1) {
		throw new Error('package.json: Versionsangabe nicht gefunden.');
	}
	return result;
}

function readVersion(packageJsonText) {
	return JSON.parse(packageJsonText).version;
}

module.exports = { bumpPatch, setVersion, setPackageVersion, readVersion };
