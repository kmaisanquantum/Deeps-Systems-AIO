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

    // Verify task creation query
    const taskInsert = queriesExecuted.find(q => q.text.includes('INSERT INTO workspace_tasks'));
    assert(taskInsert, 'sales.lead_won must trigger workspace_tasks follow-up task creation.');
    assert.strictEqual(taskInsert.params[0], tenantId);
    assert(taskInsert.params[1].includes('John Galt'));
    assert.strictEqual(taskInsert.params[3], 'mock-lead-uuid-123');
    assert.strictEqual(taskInsert.params[4], 'sales');
    assert.strictEqual(taskInsert.params[5], 'mock-lead-uuid-123');

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

    // Verify finance incoming transaction ledger entry
    const financeInsert = queriesExecuted.find(q => q.text.includes('INSERT INTO financial_transactions'));
    assert(financeInsert, 'store.checkout_completed must log financial_transactions INCOME ledger entry.');
    assert.strictEqual(financeInsert.params[0], tenantId);
    assert.strictEqual(financeInsert.params[1], 350.00);
    assert.strictEqual(financeInsert.params[2], 'PGK');
    assert.strictEqual(financeInsert.params[4], 'mock-checkout-uuid-456');

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

    // Verify finance collection transaction query
    const feeFinanceInsert = queriesExecuted.find(q => q.text.includes('INSERT INTO financial_transactions'));
    assert(feeFinanceInsert, 'fees.invoice_cleared must log a financial_transactions collection entry.');
    assert.strictEqual(feeFinanceInsert.params[0], tenantId);
    assert.strictEqual(feeFinanceInsert.params[1], 1500.00);
    assert.strictEqual(feeFinanceInsert.params[2], 'PGK');
    assert(feeFinanceInsert.params[3].includes('Tuition Payment'));
    assert.strictEqual(feeFinanceInsert.params[4], 'mock-fee-uuid-789');

    console.log('✓ fees.invoice_cleared trigger flow verified successfully.');
  }

  console.log('--- ALL CROSS-MODULE DATA MESH END-TO-END AUTOMATION TESTS PASSED SUCCESSFULY ---');
}

runDataMeshTests().catch(err => {
  console.error('Data mesh automation tests failed:', err);
  process.exit(1);
});
