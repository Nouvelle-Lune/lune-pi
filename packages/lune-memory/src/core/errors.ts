/**
 * A request to the memory that breaks a rule, such as an empty note, an unknown project or a
 * revert that cannot be done. The message says why. The daemon answers it with 400, or with 404
 * when the message names an unknown or missing thing. Other errors are faults and give 500.
 */
export class MemoryOperationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemoryOperationError";
    }
}
