// =====================================================================
// services/logisticsService.js
// Axios adapter unifying DHL and Post PNG (EMS) courier operations.
// =====================================================================
'use strict';

const axios = require('axios');
const db = require('../db');

const DHL_BASE_URL = process.env.DHL_BASE_URL || 'https://api-mydhl.dhl.com';
const DHL_API_KEY = process.env.DHL_API_KEY;

const POST_PNG_BASE_URL = process.env.POST_PNG_BASE_URL || 'https://api.postpng.com.pg';
const POST_PNG_API_KEY = process.env.POST_PNG_API_KEY;

const dhlClient = axios.create({
  baseURL: DHL_BASE_URL,
  timeout: 10000,
  headers: { 'DHL-API-Key': DHL_API_KEY, Accept: 'application/json' },
});

const postPngClient = axios.create({
  baseURL: POST_PNG_BASE_URL,
  timeout: 10000,
  headers: { Authorization: `Bearer ${POST_PNG_API_KEY}`, Accept: 'application/json' },
});

function normalizeError(err, context) {
  if (err.response) {
    return new Error(
      `[logisticsService] ${context} failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`
    );
  }
  if (err.request) {
    return new Error(`[logisticsService] ${context} failed: no response from carrier API — ${err.message}`);
  }
  return new Error(`[logisticsService] ${context} failed: ${err.message}`);
}

/**
 * Create a shipment/waybill with the given carrier, persist the resulting
 * tracking reference locally, and return the stored row.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.branchId
 * @param {'DHL'|'POST_PNG'} params.carrier
 * @param {string} params.originAddress
 * @param {string} params.destinationAddress
 * @param {number} params.weightKg
 */
async function createShipment({ tenantId, branchId, carrier, originAddress, destinationAddress, weightKg }) {
  if (!tenantId) throw new Error('[logisticsService] createShipment requires tenantId.');
  if (!['DHL', 'POST_PNG'].includes(carrier)) {
    throw new Error(`[logisticsService] unsupported carrier "${carrier}".`);
  }

  let trackingNumber;
  let waybillReference;
  let freightCost = null;

  try {
    if (carrier === 'DHL') {
      const resp = await dhlClient.post('/mydhlapi/shipments', {
        plannedShippingDateAndTime: new Date().toISOString(),
        pickup: { isRequested: false },
        productCode: 'P',
        accounts: [{ typeCode: 'shipper', number: process.env.DHL_ACCOUNT_NUMBER }],
        customerDetails: {
          shipperDetails: { postalAddress: { addressLine1: originAddress } },
          receiverDetails: { postalAddress: { addressLine1: destinationAddress } },
        },
        content: {
          packages: [{ weight: weightKg || 1 }],
          isCustomsDeclarable: false,
        },
      });
      trackingNumber = resp.data && resp.data.shipmentTrackingNumber;
      waybillReference = resp.data && resp.data.documents && resp.data.documents[0]
        ? resp.data.documents[0].content
        : null;
      freightCost = resp.data && resp.data.shipmentCharges
        ? resp.data.shipmentCharges[0].price
        : null;
    } else {
      const resp = await postPngClient.post('/v1/shipments', {
        origin_address: originAddress,
        destination_address: destinationAddress,
        weight_kg: weightKg || 1,
        service: 'EMS',
      });
      trackingNumber = resp.data && resp.data.tracking_number;
      waybillReference = resp.data && resp.data.waybill_reference;
      freightCost = resp.data && resp.data.freight_cost;
    }
  } catch (err) {
    throw normalizeError(err, `createShipment (${carrier})`);
  }

  const insertResult = await db.query(
    `INSERT INTO logistics_shipments
        (tenant_id, branch_id, carrier_name, tracking_number, waybill_reference,
         shipping_status, weight_kg, freight_cost, origin_address, destination_address)
     VALUES ($1, $2, $3, $4, $5, 'DISPATCHED', $6, $7, $8, $9)
     RETURNING *`,
    [
      tenantId,
      branchId || null,
      carrier,
      trackingNumber || null,
      waybillReference || null,
      weightKg || null,
      freightCost || null,
      originAddress || null,
      destinationAddress || null,
    ]
  );

  return insertResult.rows[0];
}

/**
 * Poll a carrier for the latest tracking status of an existing shipment
 * and sync the local row.
 * @param {string} shipmentId - local logistics_shipments.id
 */
async function fetchTrackingStatus(shipmentId) {
  const existingResult = await db.query(
    `SELECT * FROM logistics_shipments WHERE id = $1 LIMIT 1`,
    [shipmentId]
  );

  if (existingResult.rowCount === 0) {
    throw new Error(`[logisticsService] no shipment found for id ${shipmentId}`);
  }

  const shipment = existingResult.rows[0];
  let remoteStatus;

  try {
    if (shipment.carrier_name === 'DHL') {
      const resp = await dhlClient.get(`/mydhlapi/shipments/${shipment.tracking_number}/tracking`);
      const events = resp.data && resp.data.shipments && resp.data.shipments[0]
        ? resp.data.shipments[0].events
        : [];
      remoteStatus = mapDhlStatus(events && events[0] ? events[0].statusCode : null);
    } else {
      const resp = await postPngClient.get(`/v1/shipments/${shipment.tracking_number}/status`);
      remoteStatus = mapPostPngStatus(resp.data && resp.data.status);
    }
  } catch (err) {
    throw normalizeError(err, 'fetchTrackingStatus');
  }

  if (remoteStatus && remoteStatus !== shipment.shipping_status) {
    const updateResult = await db.query(
      `UPDATE logistics_shipments SET shipping_status = $1 WHERE id = $2 RETURNING *`,
      [remoteStatus, shipmentId]
    );
    return updateResult.rows[0];
  }

  return shipment;
}

function mapDhlStatus(code) {
  const map = {
    PU: 'DISPATCHED',
    TR: 'IN_TRANSIT',
    OK: 'DELIVERED',
    RT: 'FAILED',
  };
  return map[code] || 'IN_TRANSIT';
}

function mapPostPngStatus(status) {
  const map = {
    dispatched: 'DISPATCHED',
    in_transit: 'IN_TRANSIT',
    delivered: 'DELIVERED',
    failed: 'FAILED',
  };
  return status ? map[status.toLowerCase()] || 'IN_TRANSIT' : null;
}

module.exports = { createShipment, fetchTrackingStatus };
