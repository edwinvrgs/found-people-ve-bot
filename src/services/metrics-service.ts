import { incrementMetric as incrementMetricRepository } from "../repositories/found-people-repository.js";

export function incrementMetric(name: string, amount = 1) {
  return incrementMetricRepository(name, amount);
}
