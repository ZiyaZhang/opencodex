import { assertFixtureHome, controlPort } from './home.mjs';
assertFixtureHome();
const port = controlPort();
const [command = 'status', value] = process.argv.slice(2);
const paths = { status: '/status', create: '/create', trigger: '/trigger', cancel: '/cancel' };
if (!Object.hasOwn(paths, command) || (['trigger', 'cancel'].includes(command) && !value)) throw new Error('Usage: node control.mjs status | create ordinary|timed|plan | trigger SESSION_ID | cancel SESSION_ID');
const response = await fetch(`http://127.0.0.1:${port}${paths[command]}`, {
  method: command === 'status' ? 'GET' : 'POST',
  headers: { 'x-output-qa': 'local-fixture', 'content-type': 'application/json' },
  ...(command === 'status' ? {} : { body: JSON.stringify(command === 'create' ? { kind: value ?? 'ordinary' } : { sessionId: value }) }),
});
const result = await response.json(); console.log(JSON.stringify(result, null, 2)); if (!response.ok) process.exitCode = 1;
