import type { DLService } from "./BaseService";
import BuzzheavierService from "./BuzzHeavier";
import FichierService from "./1Fichier";

export function getService(name: string): DLService {
  switch (name) {
    case 'Buzzheavier':
      return new BuzzheavierService();
    case 'Fichier':
      return new FichierService();
    default:
      throw new Error(`Unknown service: ${name}`);
  }
}