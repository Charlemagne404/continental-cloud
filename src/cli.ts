import { loadConfig } from './server/config.js';
import { FileService } from './server/files.js';
import { metadataPath, MetadataDatabase } from './server/metadata.js';
import { Storage } from './server/storage.js';
import { UploadService } from './server/uploads.js';

const command = process.argv[2] ?? 'doctor';
if (!['doctor', 'scan', 'reconcile', 'cleanup', 'help'].includes(command)) {
  console.error(`Unknown command: ${command}`); process.exitCode = 2;
} else if (command === 'help') {
  console.log('continental-cloud commands:\n  cloud doctor      Storage, database, journal, and recent-job diagnostics\n  cloud scan        Reconcile filesystem contents into SQLite metadata\n  cloud reconcile   Alias for scan\n  cloud cleanup     Remove abandoned uploads and expired Trash items');
} else {
  const config = loadConfig(); const storage = new Storage(config); const status = await storage.initialize();
  const report: Record<string, unknown> = { app: 'continental-cloud', command, timestamp: new Date().toISOString(), storage: status };
  if (status.state !== 'ready') { console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; }
  else {
    const db = new MetadataDatabase(metadataPath(config.storagePath));
    try {
      await db.open(); const files = new FileService(storage, db); const uploads = new UploadService(files, config.maxUploadBytes, config.uploadChunkBytes, config.versionRetention);
      if (command === 'doctor') { report.database = db.health(); report.recentJobs = db.listJobs(10); report.changeSequence = db.latestChangeSequence(); report.storageBreakdown = db.storageBreakdown(); }
      if (command === 'scan' || command === 'reconcile') report.reconciliation = await files.reconcile();
      if (command === 'cleanup') { report.cleanedUploads = await uploads.cleanupOlderThan(); report.cleanedTrash = await files.cleanupTrashOlderThan(config.trashRetentionDays); }
      report.usageBytes = db.usage(); console.log(JSON.stringify(report, null, 2));
    } finally { db.close(); }
  }
}
