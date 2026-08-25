import { scaffoldSource } from "../scaffold.js";

/**
 * Wikimedia REST pageviews (keyless; counts are CC0). The real ingestor
 * walks the curated article map in data/wiki-articles.json day by day.
 */
export const wikimediaSource = scaffoldSource({
  id: "wikimedia",
  title: "Wikimedia pageviews",
  datasets: ["wiki-pageviews"],
});
