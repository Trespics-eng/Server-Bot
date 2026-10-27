import fs from 'fs';
import path from 'path';
import { ConnectionManager, ConnectionStatus } from '../src/worker/connectionManager.js';

describe('ConnectionManager - Multi-Account Isolation and Lifecycle', () => {
  const testBaseAuth = path.resolve('./server/tests/fixtures/auth');
  const testBaseDownload = path.resolve('./server/tests/fixtures/downloads');
  let manager;

  beforeEach(() => {
    // Clean test directories
    if (fs.existsSync(testBaseAuth)) {
      fs.rmSync(testBaseAuth, { recursive: true, force: true });
    }
    if (fs.existsSync(testBaseDownload)) {
      fs.rmSync(testBaseDownload, { recursive: true, force: true });
    }
    manager = new ConnectionManager({
      baseAuthDir: testBaseAuth,
      baseDownloadDir: testBaseDownload,
      qrTtlMs: 500, // 500ms for fast expiration testing
    });
  });

  afterEach(() => {
    manager.shutdownAll();
    if (fs.existsSync(testBaseAuth)) {
      fs.rmSync(testBaseAuth, { recursive: true, force: true });
    }
    if (fs.existsSync(testBaseDownload)) {
      fs.rmSync(testBaseDownload, { recursive: true, force: true });
    }
  });

  test('demonstrates strict account directory isolation between Account 1 and Account 2', () => {
    const account1 = 'acc-user-1111';
    const account2 = 'acc-user-2222';

    const session1 = manager.initAccount(account1, { userId: 'u1', label: 'Primary Biz' });
    const session2 = manager.initAccount(account2, { userId: 'u2', label: 'Support Line' });

    // Distinct session objects
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    expect(session1.accountId).toBe(account1);
    expect(session2.accountId).toBe(account2);

    // Completely isolated filesystem paths
    expect(session1.authDir).toBe(path.join(testBaseAuth, account1));
    expect(session2.authDir).toBe(path.join(testBaseAuth, account2));
    expect(session1.downloadDir).toBe(path.join(testBaseDownload, account1));
    expect(session2.downloadDir).toBe(path.join(testBaseDownload, account2));

    expect(fs.existsSync(session1.authDir)).toBe(true);
    expect(fs.existsSync(session2.authDir)).toBe(true);

    // Write a dummy token to Account 1
    fs.writeFileSync(path.join(session1.authDir, 'creds.json'), JSON.stringify({ token: 'secret-111' }));

    // Verify Account 2 does not see Account 1's files
    expect(fs.existsSync(path.join(session2.authDir, 'creds.json'))).toBe(false);

    // Isolated caches
    session1.signalKeyCache.set('key1', 'val1');
    expect(session2.signalKeyCache.get('key1')).toBeUndefined();
  });

  test('prevents path traversal attacks in account IDs', () => {
    expect(() => manager.initAccount('../malicious')).toThrow(/Invalid accountId format/);
    expect(() => manager.initAccount('/root/secret')).toThrow(/Invalid accountId format/);
    expect(() => manager.initAccount('../../etc/passwd')).toThrow(/Invalid accountId format/);
    expect(() => manager.initAccount('')).toThrow(/Invalid accountId format/);
  });

  test('safely returns public status without leaking credentials or tokens', () => {
    const accountId = 'acc-test-3333';
    manager.initAccount(accountId, { userId: 'usr-999', label: 'Sales Bot' });

    const status = manager.getStatus(accountId);
    expect(status).toEqual({
      accountId: 'acc-test-3333',
      userId: 'usr-999',
      phoneNumber: null,
      label: 'Sales Bot',
      status: ConnectionStatus.PENDING,
      connectedAt: null,
      reconnectAttempts: 0,
      hasQR: false,
      pairingCode: null,
      pairingCodeExpiresAt: null,
      lastError: null,
      lastDisconnectReason: null,
    });

    // Ensure no sensitive fields
    expect(status.authDir).toBeUndefined();
    expect(status.downloadDir).toBeUndefined();
    expect(status.sock).toBeUndefined();
    expect(status.creds).toBeUndefined();
  });

  test('handles QR code lifecycle and automatic expiration', async () => {
    const accountId = 'acc-qr-test';
    manager.initAccount(accountId);

    // Simulate QR generation
    await manager.handleConnectionUpdate(accountId, {
      qr: '2@test-qr-baileys-payload-12345',
    });

    let qrInfo = manager.getQR(accountId);
    expect(qrInfo.status).toBe(ConnectionStatus.QR_READY);
    expect(qrInfo.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qrInfo.expired).toBe(false);

    // Wait for TTL expiration (500ms)
    await new Promise((res) => setTimeout(res, 600));

    qrInfo = manager.getQR(accountId);
    expect(qrInfo.expired).toBe(true);
    expect(qrInfo.qrDataUrl).toBeNull();
  });

  test('independent disconnection: disconnecting Account 1 does not affect Account 2', async () => {
    const account1 = 'acc-indep-1';
    const account2 = 'acc-indep-2';

    manager.initAccount(account1);
    manager.initAccount(account2);

    // Fake connection for both
    await manager.handleConnectionUpdate(account1, { connection: 'open' });
    await manager.handleConnectionUpdate(account2, { connection: 'open' });

    expect(manager.getStatus(account1).status).toBe(ConnectionStatus.CONNECTED);
    expect(manager.getStatus(account2).status).toBe(ConnectionStatus.CONNECTED);

    // Disconnect Account 1
    const disconnected = manager.disconnect(account1);
    expect(disconnected).toBe(true);

    expect(manager.getStatus(account1).status).toBe(ConnectionStatus.DISCONNECTED);
    expect(manager.getStatus(account2).status).toBe(ConnectionStatus.CONNECTED);
  });

  test('removes account and cleans up disk resources', () => {
    const accountId = 'acc-to-delete';
    const session = manager.initAccount(accountId);
    fs.writeFileSync(path.join(session.downloadDir, 'photo.jpg'), 'content');

    expect(fs.existsSync(session.downloadDir)).toBe(true);

    manager.removeAccount(accountId, true);

    expect(manager.getStatus(accountId)).toBeNull();
    expect(fs.existsSync(session.downloadDir)).toBe(false);
  });
});
