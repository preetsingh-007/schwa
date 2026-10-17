// Runs the setup commands for real in a fresh clone and records every output
// line with its timestamp, for the terminal scenes in the setup guide.
//
//   node scripts/demo/capture-terminal.mjs <workDir> <out.json> [repoUrl]
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [work, out, repo = 'https://github.com/preetsingh-007/schwa.git'] = process.argv.slice(2);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', npm_config_color: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };

function run(cmd, cwd, { until, killAfter } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const lines = [];
    const p = spawn('bash', ['-c', cmd], { cwd, env, detached: true });
    let buf = '';
    const onData = (d) => {
      buf += d.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const l of parts) {
        lines.push({ t: (Date.now() - t0) / 1000, text: l.replace(/\r/g, '') });
        if (until && until.test(l)) setTimeout(() => { try { process.kill(-p.pid); } catch { /* gone */ } }, killAfter ?? 500);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (code) => {
      if (buf) lines.push({ t: (Date.now() - t0) / 1000, text: buf });
      console.log(`$ ${cmd}  (${((Date.now() - t0) / 1000).toFixed(1)} s, exit ${code})`);
      resolve({ cmd, lines, secs: (Date.now() - t0) / 1000, code });
    });
  });
}

const dir = join(work, 'schwa');
const steps = [
  await run(`git clone ${repo}`, work),
  await run('npm install', dir),
  await run('npm test', dir),
  await run('npm run dev', dir, { until: /Local:/, killAfter: 800 }),
];
writeFileSync(out, JSON.stringify(steps, null, 1));
