import { EntitlementService } from '../src/services/entitlementService.js';
import { PaymentService } from '../src/services/paymentService.js';

describe('Entitlement Engine & Subscription Logic', () => {
  test('All-In-One bundle (bundle_all) entitles any feature for the account', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Mock DB client returning an active 'bundle_all' subscription
    const mockDb = {
      from: (table) => {
        if (table === 'whatsapp_accounts') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'acc-bundle-test',
                    status: 'connected',
                    user_id: 'usr-1',
                    profiles: { trial_used: true, trial_expires_at: null },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'subscriptions') {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  eq: () => ({
                    gt: async () => ({
                      data: [
                        {
                          id: 'sub-bundle-1',
                          feature_code: 'bundle_all',
                          status: 'active',
                          end_at: futureDate,
                        },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const service = new EntitlementService(mockDb);

    // Verify Anti-Delete is entitled via bundle_all
    const antiDeleteCheck = await service.isFeatureEntitled('acc-bundle-test', 'anti_delete');
    expect(antiDeleteCheck.entitled).toBe(true);
    expect(antiDeleteCheck.reason).toBe('bundle_all_subscription');

    // Verify Auto-Reply is entitled via bundle_all
    const autoReplyCheck = await service.isFeatureEntitled('acc-bundle-test', 'auto_reply');
    expect(autoReplyCheck.entitled).toBe(true);
    expect(autoReplyCheck.reason).toBe('bundle_all_subscription');

    // Verify File Organizer is entitled via bundle_all
    const fileOrgCheck = await service.isFeatureEntitled('acc-bundle-test', 'file_organizer');
    expect(fileOrgCheck.entitled).toBe(true);
    expect(fileOrgCheck.reason).toBe('bundle_all_subscription');
  });

  test('standalone feature subscription entitles only the purchased feature', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const mockDb = {
      from: (table) => {
        if (table === 'whatsapp_accounts') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'acc-single-test',
                    status: 'connected',
                    user_id: 'usr-2',
                    profiles: { trial_used: true, trial_expires_at: null },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'subscriptions') {
          return {
            select: () => ({
              eq: () => ({
                in: (_col, codes) => ({
                  eq: () => ({
                    gt: async () => {
                      // Only anti_delete has an active subscription
                      if (codes.includes('anti_delete')) {
                        return {
                          data: [
                            {
                              id: 'sub-anti-del',
                              feature_code: 'anti_delete',
                              status: 'active',
                              end_at: futureDate,
                            },
                          ],
                          error: null,
                        };
                      }
                      return { data: [], error: null };
                    },
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const service = new EntitlementService(mockDb);

    // anti_delete should be entitled
    const antiDelCheck = await service.isFeatureEntitled('acc-single-test', 'anti_delete');
    expect(antiDelCheck.entitled).toBe(true);
    expect(antiDelCheck.reason).toBe('feature_subscription');

    // auto_reply should NOT be entitled
    const autoReplyCheck = await service.isFeatureEntitled('acc-single-test', 'auto_reply');
    expect(autoReplyCheck.entitled).toBe(false);
    expect(autoReplyCheck.reason).toBe('unsubscribed_or_expired');
  });

  test('active 7-day free trial entitles all features', async () => {
    const trialExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

    const mockDb = {
      from: (table) => {
        if (table === 'whatsapp_accounts') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'acc-trial-test',
                    status: 'connected',
                    user_id: 'usr-trial',
                    profiles: { trial_used: true, trial_expires_at: trialExpiry },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const service = new EntitlementService(mockDb);

    const check = await service.isFeatureEntitled('acc-trial-test', 'anti_view_once');
    expect(check.entitled).toBe(true);
    expect(check.reason).toBe('trial');
  });
});

describe('PaymentService Idempotency & Webhook Handling', () => {
  test('duplicate M-Pesa callback is safely ignored without re-activation', async () => {
    // Mock DB where payment is already marked 'success'
    const mockDb = {
      from: (table) => {
        if (table === 'payments') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'pay-123',
                    status: 'success', // Already succeeded!
                    order_id: 'ord-123',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const paymentService = new PaymentService(mockDb);

    const duplicateCallback = {
      Body: {
        stkCallback: {
          MerchantRequestID: 'mr_111',
          CheckoutRequestID: 'ws_already_processed',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
        },
      },
    };

    const result = await paymentService.handleMpesaCallback(duplicateCallback);
    expect(result.handled).toBe(true);
    expect(result.status).toBe('already_completed');
  });
});
