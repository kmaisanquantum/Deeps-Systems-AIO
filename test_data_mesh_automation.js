const assert = require('assert');
const eventDispatcher = require('./services/eventDispatcher');
const db = require('./db');

// In-memory query logger to track inserts and updates
const queriesExecuted = [];

db.query = async (text, params) => {
  queriesExecuted.push({ text: text.trim().replace(/\s+/g, ' '), params });

  if (text.includes('INSERT INTO contacts')) {
    return { rowCount: 1, rows: [{ id: 'mock-contact-uuid-111' }] };
  }
  if (text.includes('INSERT INTO workspace_tasks')) {
    return { rowCount: 1, rows: [{ id: 'mock-task-uuid-222' }] };
  }
  if (text.includes('INSERT INTO financial_transactions')) {
    return { rowCount: 1, rows: [{ id: 'mock-tx-uuid-333' }] };
  }
  return { rowCount: 1, rows: [{ id: 'mock-uuid-999' }] };
};

async function runDataMeshTests() {
  console.log('--- STARTING CROSS-MODULE DATA MESH END-TO-END AUTOMATION TESTS ---');

  const tenantId = 'tenant-mesh-777';

  // 1. Test sales.lead_won Trigger Flow
  {
    queriesExecuted.length = 0;
    const leadPayload = {
      lead: {
        id: 'mock-lead-uuid-123',
        full_name: 'John Galt',
        email: 'john@galt.com',
        deal_value: 50000.00,
        stage: 'Won'
      }
    };

    console.log('Emitting sales.lead_won event...');
    await eventDispatcher.dispatch('sales.lead_won', tenantId, leadPayload);

    // Wait a brief tick for async event execution
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify contact creation query
    const contactInsert = queriesExecuted.find(q => q.text.includes('INSERT INTO contacts'));
    assert(contactInsert, 'sales.lead_won must trigger a contact creation insert in contacts table.');
    assert.strictEqual(contactInsert.params[0], tenantId);
    assert.strictEqual(contactInsert.params[1], 'John');
    assert.strictEqual(contactInsert.params[3], 'john@galt.com');

    // Verify lead contact_id update query
    const leadUpdate = queriesExecuted.find(q => q.text.includes('UPDATE sales_leads'));
    assert(leadUpdate, 'sales.lead_won must trigger an update on sales_leads with the contact_id.');
    assert.strictEqual(leadUpdate.params[0], 'mock-contact-uuid-111');
    assert.strictEqual(leadUpdate.params[1], 'mock-lead-uuid-123');

    // Verify task creation query (run via workspaceController)
    const taskInsert = queriesExecuted.find(q => q.text.includes('INSERT INTO workspace_tasks'));
    assert(taskInsert, 'sales.lead_won must trigger workspace_tasks follow-up task creation.');
    assert.strictEqual(taskInsert.params[0], tenantId);
    assert.strictEqual(taskInsert.params[2], 'Follow up with John Galt');

    // Verify task update query with lead_id tracer
    const taskUpdate = queriesExecuted.find(q => q.text.includes('UPDATE workspace_tasks'));
    assert(taskUpdate, 'sales.lead_won must trigger update on workspace_tasks to link lead_id and source_module.');
    assert.strictEqual(taskUpdate.params[0], 'mock-lead-uuid-123');
    assert.strictEqual(taskUpdate.params[1], 'mock-lead-uuid-123');
    assert.strictEqual(taskUpdate.params[2], 'mock-task-uuid-222');

    console.log('✓ sales.lead_won trigger flow verified successfully.');
  }

  // 2. Test store.checkout_completed Trigger Flow
  {
    queriesExecuted.length = 0;
    const checkoutPayload = {
      checkout: {
        id: 'mock-checkout-uuid-456',
        amount: 350.00,
        currency: 'PGK',
        email: 'customer@galt.com'
      }
    };

    console.log('Emitting store.checkout_completed event...');
    await eventDispatcher.dispatch('store.checkout_completed', tenantId, checkoutPayload);

    // Wait a brief tick
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify logistics shipment creation query
    const shipmentInsert = queriesExecuted.find(q => q.text.includes('INSERT INTO logistics_shipments'));
    assert(shipmentInsert, 'store.checkout_completed must trigger logistics_shipments provisioning.');
    assert.strictEqual(shipmentInsert.params[0], tenantId);
    assert.strictEqual(shipmentInsert.params[1], 'mock-checkout-uuid-456');
    assert(shipmentInsert.params[2].includes('customer@galt.com'));

    // Verify finance incoming transaction ledger entry (run via financeController)
    const financeInsert = queriesExecuted.find(q => q.text.includes('INSERT INTO financial_transactions') && q.text.includes('INSERT'));
    assert(financeInsert, 'store.checkout_completed must log financial_transactions INCOME ledger entry.');
    assert.strictEqual(financeInsert.params[0], tenantId);
    assert.strictEqual(financeInsert.params[3], 'INCOME');
    assert.strictEqual(financeInsert.params[4], 350.00);
    assert.strictEqual(financeInsert.params[5], 'PGK');

    // Verify finance update query with checkout tracer
    const financeUpdate = queriesExecuted.find(q => q.text.includes('UPDATE financial_transactions'));
    assert(financeUpdate, 'store.checkout_completed must update financial_transactions with store source_module tracer.');
    assert.strictEqual(financeUpdate.params[0], 'mock-checkout-uuid-456');
    assert.strictEqual(financeUpdate.params[1], 'mock-tx-uuid-333');

    console.log('✓ store.checkout_completed trigger flow verified successfully.');
  }

  // 3. Test fees.invoice_cleared Trigger Flow
  {
    queriesExecuted.length = 0;
    const feePayload = {
      fee: {
        id: 'mock-fee-uuid-789',
        fee_name: 'Tuition Payment',
        amount: 1500.00,
        currency: 'PGK'
      }
    };

    console.log('Emitting fees.invoice_cleared event...');
    await eventDispatcher.dispatch('fees.invoice_cleared', tenantId, feePayload);

    // Wait a brief tick
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify finance collection transaction query (run via financeController)
    const feeFinanceInsert = queriesExecuted.find(q => q.text.includes('INSERT INTO financial_transactions') && q.text.includes('INSERT'));
    assert(feeFinanceInsert, 'fees.invoice_cleared must log a financial_transactions collection entry.');
    assert.strictEqual(feeFinanceInsert.params[0], tenantId);
    assert.strictEqual(feeFinanceInsert.params[3], 'INCOME');
    assert.strictEqual(feeFinanceInsert.params[4], 1500.00);
    assert.strictEqual(feeFinanceInsert.params[5], 'PGK');

    // Verify finance update query with fee tracer
    const feeFinanceUpdate = queriesExecuted.find(q => q.text.includes('UPDATE financial_transactions'));
    assert(feeFinanceUpdate, 'fees.invoice_cleared must update financial_transactions with fees source_module tracer.');
    assert.strictEqual(feeFinanceUpdate.params[0], 'mock-fee-uuid-789');
    assert.strictEqual(feeFinanceUpdate.params[1], 'mock-tx-uuid-333');

    console.log('✓ fees.invoice_cleared trigger flow verified successfully.');
  }

  console.log('--- ALL CROSS-MODULE DATA MESH END-TO-END AUTOMATION TESTS PASSED SUCCESSFULY ---');
}

runDataMeshTests().catch(err => {
  console.error('Data mesh automation tests failed:', err);
  process.exit(1);
});
