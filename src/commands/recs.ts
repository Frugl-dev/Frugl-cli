import Recommendations from "./recommendations.js";

export default class Recs extends Recommendations {
  static override hidden = true;
  static override aliases: string[] = [];
}
