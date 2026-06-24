'use strict';

// A fatal tool error signals that the tool loop must stop immediately and
// propagate the error rather than feeding it back to the model as a retryable
// tool_result. Use for unrecoverable situations (auth failures, invalid config)
// where the model retrying the same command will never succeed.
export class FatalToolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FatalToolError';
    }
}
