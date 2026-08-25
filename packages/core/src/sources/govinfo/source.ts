import { scaffoldSource } from "../scaffold.js";

/**
 * GPO GovInfo bulk BILLSTATUS data (keyless). The real ingestor walks bill
 * status XML per congress and bill type.
 */
export const govinfoSource = scaffoldSource({
  id: "govinfo",
  title: "GovInfo (bill status)",
  datasets: ["bills"],
});
