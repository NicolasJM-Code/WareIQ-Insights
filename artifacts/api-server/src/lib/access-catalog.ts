// Permission identifiers match the published name-only frontend catalogue.
// This is metadata, not executable SQL or a WMS source mapping.
const sections = [
  ["dashboard", "Executive Dashboard", "Warehouse Performance Summary|Daily Operations Summary|Warehouse KPI Dashboard|Order Fulfilment Performance|Inventory Accuracy Summary|Inbound vs Outbound Volume|Warehouse Productivity Summary|Outstanding Tasks and Exceptions"],
  ["inbound", "Inbound / Receiving", "Expected vs Received Quantities|Goods Received Report|Receipts by Supplier|Receipts by Product|Outstanding Purchase Orders|Receiving Discrepancy Report|Receiving Productivity Report|Dock-to-Stock Time|Overdue Receipts|Goods Received by Date and Time"],
  ["putaway", "Put-away and Locations", "Put-away Task Status|Outstanding Put-away Tasks|Put-away Productivity|Put-away Cycle Time|Stock by Warehouse Location|Location Utilisation|Empty and Available Locations|Blocked Locations|Location Capacity Report|Put-away Exceptions"],
  ["inventory", "Inventory Management", "Stock on Hand|Available vs Allocated Stock|Stock by Product|Stock by Warehouse and Location|Stock by Batch / Lot|Stock Ageing|Expiry and Near-Expiry Stock|Slow-Moving and Non-Moving Stock|Negative Stock Report|Inventory Adjustments|Inventory Valuation (if cost data is available)|Stock Movement History|Stock Discrepancy Report|Out-of-Stock Report"],
  ["picking", "Replenishment and Picking", "Replenishment Requirements|Replenishment Task Status|Outstanding Replenishment Tasks|Pick-Face Stock Availability|Picking Performance by Operator|Picking Productivity by Hour|Picking Accuracy|Short Pick Report|Picking Exceptions|Orders Awaiting Picking|Picking Cycle Time|Replenishment Frequency by Product"],
  ["outbound", "Outbound / Order Fulfilment", "Customer Orders Received|Orders Released for Picking|Orders Awaiting Fulfilment|Orders Picked but Not Packed|Orders Packed but Not Dispatched|Order Fulfilment Rate|Order Fill Rate|Order Cycle Time|On-Time In-Full (OTIF) Performance|Backorder Report|Short Shipment Report|Order Cancellation Report|Customer Order History|Fulfilment Performance by Customer"],
  ["dispatch", "Loading and Dispatch", "Dispatch Summary|Loads by Route and Vehicle|Orders Assigned to Loads|Loading Progress|Loading Productivity|Dispatch Cut-off Compliance|Shipment Discrepancies|Dispatch Delays|Vehicle Load Utilisation|Dispatch Confirmation Report|Proof of Delivery Status (if available)|Dispatch History by Date"],
  ["traceability", "Traceability", "Product Traceability Report|Batch / Lot Traceability|Forward Traceability — Supplier to Customer|Backward Traceability — Customer to Supplier|Batch Movement History|Serial Number Traceability (if applicable)|Batch Stock by Location|Batch Receipt History|Batch Allocation and Picking History|Batch Dispatch and Shipment History|Product Recall Report|Expired and Recalled Stock|Quarantined Stock|Supplier-to-Customer Traceability|Batch Quantity Reconciliation|Traceability Audit Trail"],
  ["stock-counts", "Stock Counts and Adjustments", "Cycle Count Schedule|Cycle Count Completion|Stock Count Variances|Stock Count Accuracy|Adjustments by Product|Adjustments by Location|Adjustments by Operator|Adjustment Reasons|Pending Adjustment Approvals|Repeated Stock Discrepancies|Physical vs System Stock|Inventory Write-Off Report"],
  ["labour", "Labour and Productivity", "Productivity by Operator|Productivity by Activity|Units Processed per Hour|Order Lines Picked per Hour|Cases Received per Hour|Put-away Tasks per Hour|Tasks Completed vs Assigned|Task Duration Analysis|Warehouse Activity by Shift|Productivity by Team|Labour Utilisation (if time data is available)|Performance Against Targets"],
  ["exceptions", "Exceptions and Operational Reporting", "Overdue Task Report|Failed WMS Transactions|Inventory Discrepancies|Orders on Hold|Blocked Stock|Expired Stock Exceptions|Near-Expiry Stock Exceptions|Negative Stock Exceptions|Unallocated Orders|Missed Dispatch Cut-offs|Receiving Discrepancies|Picking and Loading Errors|Unprocessed Transactions|Operational Exception Summary"],
  ["settings", "Settings and Administration", "Database Connection Status|Database Connection History|Reporting Refresh Status|Report Execution History|User Access and Permissions|User Activity Audit Log|Configuration Change Log|Scheduled Reports|Report Export History|System Error Log|KPI Target Configuration|Data Quality and Validation Report"],
] as const;
export const accessReports = sections.flatMap(([section, sectionName, names]) =>
  names.split("|").map((name, i) => ({ id: `${section}-${i + 1}`, name, section, sectionName })));

export const sectionDatasets: Record<string, Record<string, string[]>> = {
  inbound: { receipts: ["id", "po", "supplier", "wh", "date", "dock", "lines", "expected", "received", "variance", "dockToStockMin", "status", "receiver"] },
  putaway: {
    putaway: ["id", "grn", "sku", "name", "qty", "from", "to", "wh", "date", "minutes", "status", "operator"],
    locations: ["code", "zone", "wh", "type", "capacity", "used", "free", "utilisation", "blocked", "blockReason"],
  },
  inventory: { stock: ["sku", "name", "category", "supplier", "batch", "location", "wh", "onHand", "allocated", "available", "expiry", "receivedAt", "ageDays", "value", "status"] },
  picking: {
    picks: ["id", "order", "sku", "name", "location", "wh", "date", "requested", "picked", "short", "seconds", "operator", "status"],
    replen: ["id", "sku", "name", "pickFace", "wh", "date", "min", "max", "current", "required", "source", "priority", "status"],
  },
  outbound: { orders: ["id", "customer", "wh", "date", "promised", "lines", "units", "unitsShipped", "status", "cycleHrs", "fillRate", "otif", "route"] },
  dispatch: { loads: ["id", "route", "vehicle", "carrier", "wh", "date", "cutoff", "departed", "orders", "pallets", "loadedPct", "discrepancies", "status"] },
  traceability: {
    batches: ["batch", "serial", "sku", "name", "barcode", "category", "supplier", "wh", "grn", "po", "expiry", "receivedQty", "remainingQty", "remainingLocations", "eventCount", "lastEventAt", "lastEventKind", "orders", "shipments"],
    events: ["at", "batch", "sku", "name", "wh", "kind", "qty", "location", "ref", "operator", "note"],
  },
  "stock-counts": { counts: ["id", "plan", "location", "sku", "name", "category", "wh", "date", "system", "counted", "variance", "varianceValue", "reason", "approval", "counter", "repeat"] },
  labour: { shifts: ["operator", "role", "wh", "date", "hours", "tasks", "lines", "units", "idleMin", "linesPerHour"] },
  exceptions: { exceptions: ["id", "type", "severity", "ref", "wh", "date", "owner", "status", "detail"] },
  settings: {
    prefs: ["setting", "value", "defaultValue", "changed", "scope"],
    readiness: ["section", "datasets", "fieldCount", "defaults", "own", "dateScope", "siteScope", "source", "live"],
  },
};
sectionDatasets.dashboard = {
  orders: sectionDatasets.outbound.orders,
  shifts: sectionDatasets.labour.shifts,
  daily: ["day", "wh", "ordersIn", "dispatched", "units", "shipped", "otif", "hours", "lines", "operators"],
};

export function allowedSection(reportIds: string[], section: string): boolean {
  return accessReports.some((r) => r.section === section && reportIds.includes(r.id));
}
