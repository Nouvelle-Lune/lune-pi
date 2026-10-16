export const retryPolicy = {
    attempts: 1,
    delayMs: 100,
};

export async function retry(operation) {
    for (let attempt = 1; attempt <= retryPolicy.attempts; attempt++) {
        try {
            return await operation(attempt);
        } catch (error) {
            if (!error.transient || attempt === retryPolicy.attempts) throw error;
            await new Promise((resolve) => setTimeout(resolve, retryPolicy.delayMs));
        }
    }
}
