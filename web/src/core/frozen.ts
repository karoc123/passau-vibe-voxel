// A read-only value (Object.freeze, typed as its plain object: Object.freeze's own typing keeps an object literal's
// numbers as literal types, so a copy with other numbers would not fit). The tuning (sim/tuning.ts) is made of these.
export const frozen = <T extends object>(o: T): Readonly<T> => Object.freeze(o);
