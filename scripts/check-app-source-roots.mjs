import { readdir } from 'node:fs/promises';
import process from 'node:process';

const sourceRoots = [
  {
    path: 'apps/server/src',
    allowedFiles: new Set(['index.ts', 'production-index.ts']),
  },
  {
    path: 'apps/production-agent/src',
    allowedFiles: new Set(['index.ts']),
  },
];

const violations = [];

for (const sourceRoot of sourceRoots) {
  const entries = await readdir(sourceRoot.path, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && !sourceRoot.allowedFiles.has(entry.name)) {
      violations.push(`${sourceRoot.path}/${entry.name}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    [
      'La arquitectura no permite archivos de implementación sueltos en estas raíces:',
      ...violations.map((file) => `- ${file}`),
      'Mueve cada archivo a bootstrap, core, domain, application, infrastructure o una feature.',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  process.stdout.write('Las raíces de server y production-agent respetan sus límites.\n');
}
