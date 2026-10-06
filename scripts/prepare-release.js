'use strict';
// Ausdrücklich gestartete Release-Vorbereitung: npm run release:prepare
// Erst Tests und Packaging; nur bei Erfolg wird die Patch-Version einmal erhöht.
// Kein Commit, Tag, Push, keine VSIX, keine Veröffentlichung.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bumpPatch, setVersion, setPackageVersion, readVersion } = require('./releaseVersion.js');

const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

function run(script) {
	console.log(`> npm run ${script}`);
	const result = spawnSync(`npm run ${script}`, { cwd: root, stdio: 'inherit', shell: true });
	return result.status === 0;
}

function main() {
	const packageText = fs.readFileSync(packagePath, 'utf8');
	const lockText = fs.readFileSync(lockPath, 'utf8');
	const current = readVersion(packageText);
	const next = bumpPatch(current);
	// Vorab prüfen, damit nach erfolgreicher Validierung nichts mehr scheitert.
	const newPackage = setPackageVersion(packageText, current, next);
	const newLock = setVersion(lockText, 2, current, next);

	for (const script of ['test', 'package']) {
		if (!run(script)) {
			console.error(`Validierung fehlgeschlagen (npm run ${script}). Version bleibt ${current}.`);
			return 1;
		}
	}

	fs.writeFileSync(packagePath, newPackage);
	fs.writeFileSync(lockPath, newLock);
	console.log(`Version erhöht: ${current} -> ${next}`);
	console.log('Kein Commit, Tag, Push oder VSIX erzeugt.');
	return 0;
}

try {
	process.exitCode = main();
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
