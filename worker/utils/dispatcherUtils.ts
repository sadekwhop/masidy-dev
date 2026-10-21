/**
 * Dispatcher Utility Functions
 * 
 * Shared utility for detecting the optional legacy dispatch namespace binding.
 */

export function isDispatcherAvailable(
	env: Env,
): env is Env & { DISPATCHER: DispatchNamespace } {
    // The production Masidy deployment does not configure this legacy binding.
    return 'DISPATCHER' in env && env.DISPATCHER != null;
}