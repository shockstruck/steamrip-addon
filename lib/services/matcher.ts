import type { DLService } from "./BaseService";
import BuzzheavierService from "./BuzzHeavier";
import FischierService from "./1Fischier";

export function getService(name: string): DLService {
  switch (name) {
    case 'Buzzheavier':
      return new BuzzheavierService();
    case '1Fischier':
      return new FischierService();
    default:
      throw new Error(`Unknown service: ${name}`);
  }
}