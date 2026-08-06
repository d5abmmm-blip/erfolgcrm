/** Публичный API модуля attestations (Stage 10'.I). */
export { attestationsRouter } from './router';
export { ATTESTATION_CATEGORIES, isKnownCategory, type AttestationCategory } from './categories';
export {
  checkAttestationForAssignment,
  createAttestation,
  EngineerNotFoundError,
  getActiveCategoriesForEngineer,
  getAttestationById,
  listAttestations,
  softDeleteAttestation,
  updateAttestation,
  type AttestationInput,
  type AttestationRow,
  type AttestationStatus,
} from './repository';
