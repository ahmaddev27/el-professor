/**
 * The monthly-plan engine (§15): pure logic, no supabase, no React.
 *
 * blocks → availability → assign → validate is the pipeline; hoursRange is the
 * one place salary becomes hours. Screens and documents consume these and add
 * nothing of their own to the rules.
 */
export * from './blocks';
export * from './hoursRange';
export * from './availability';
export * from './assign';
export * from './validate';
