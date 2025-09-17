import { closeDB, initDB } from './index';

async function main() {
  console.log('[migrate] starting manual migration');
  try {
    await initDB();
    console.log('[migrate] completed successfully');
  } catch (err) {
    console.error('[migrate] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await closeDB();
  }
}

if (require.main === module) {
  void main();
}
