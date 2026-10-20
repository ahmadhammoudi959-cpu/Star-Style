import { expect, it } from "vitest";
import { visualRuns } from "../src/lib/pdf";

// Sichtbare Reihenfolge (links → rechts) für arabische/gemischte Texte im PDF
const v = (t: string) => visualRuns(t).map((r) => (r.ar ? `[${r.t}]` : r.t)).join("|");
it("Arabisch und gemischte Zeilen", () => {
  expect(v("Kinderstuhl Friseur")).toBe("Kinderstuhl Friseur");
  expect(v("Salon محمد GmbH")).toBe("Salon |[محمد]| GmbH");
  expect(v("شارع الملك 12")).toBe("12 |[شارع الملك]");
  expect(v("شامبو احترافي 250 ml – كبير / أحمر")).toBe("[أحمر]| / |[كبير]| – 250 ml |[شامبو احترافي]");
  expect(v("صالون (فرع 2)")).toBe("(2 |[فرع]|) |[صالون]");
});
