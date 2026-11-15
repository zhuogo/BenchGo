import { transferLegacyTaskOwnership } from '../plugins/superagent/src/legacy-ownership-transfer.mjs';

const values = {}, fields = new Map([
  ['--owner-db', 'ownerFilename'], ['--executor-db', 'executorFilename'], ['--device-id', 'deviceId'],
  ['--host-id', 'hostId'], ['--authorization-id', 'authorizationId'], ['--principal-device-id', 'principalDeviceId'],
]);
try {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--apply') { values.apply = true; continue; }
    if (key === '--help') {
      process.stdout.write('停止两端宿主后运行。默认只预览；--apply 才会原子迁移两端业务数据。\nnode scripts/migrate-remote-task-ownership.mjs --owner-db <A assistant.db> --executor-db <B assistant.db> --device-id <A所见B设备ID> --host-id <B hostId> --authorization-id <A到B授权ID> --principal-device-id <B所见A设备ID> [--apply]\n旧官方会话仍在 B，未知执行不会自动重派或恢复。路径必须指向离线权威数据库，不能用副本冒充迁移完成。\n');
      process.exit(0);
    }
    if (!fields.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`无效参数：${key}`);
    if (Object.hasOwn(values, fields.get(key))) throw new Error(`重复参数：${key}`);
    values[fields.get(key)] = args[++index];
  }
  for (const field of fields.values()) if (!values[field]) throw new Error(`缺少参数：${[...fields].find(([, value]) => value === field)[0]}`);
  process.stdout.write(JSON.stringify(transferLegacyTaskOwnership(values), null, 2) + '\n');
} catch (error) {
  process.stderr.write(`${error.code || 'MIGRATION_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
}
