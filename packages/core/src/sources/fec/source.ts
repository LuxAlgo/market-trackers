import { scaffoldSource } from "../scaffold.js";

/**
 * FEC bulk downloads (keyless): candidate masters/summaries and
 * committee→candidate contributions, per two-year cycle.
 */
export const fecSource = scaffoldSource({
  id: "fec",
  title: "FEC campaign finance",
  datasets: ["fec-candidates", "fec-contributions"],
});
