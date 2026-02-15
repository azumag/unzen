/**
 * FunctionRegistry - Internal storage for function definitions
 *
 * This class manages the registration and retrieval of function definitions.
 * It provides a simple in-memory store with basic CRUD operations.
 *
 * Design rationale:
 * - Uses Map for O(1) lookup performance (critical for high-traffic scenarios)
 * - Allows overwriting to support function updates during development
 * - Returns copies of internal state to prevent external mutation
 */

import type { FunctionDefinition } from '@unzen/shared';

export class FunctionRegistry {
  /**
   * Internal storage for function definitions
   * Key: function name, Value: function definition
   */
  private functions: Map<string, FunctionDefinition>;

  constructor() {
    this.functions = new Map();
  }

  /**
   * Register a function definition
   *
   * If a function with the same name already exists, it will be overwritten.
   * This allows for function updates during development.
   *
   * @param def - Function definition to register
   */
  register(def: FunctionDefinition): void {
    this.functions.set(def.name, def);
  }

  /**
   * Retrieve a function definition by name
   *
   * @param name - Function name
   * @returns Function definition if found, undefined otherwise
   */
  get(name: string): FunctionDefinition | undefined {
    return this.functions.get(name);
  }

  /**
   * Check if a function is registered
   *
   * @param name - Function name
   * @returns true if function exists, false otherwise
   */
  has(name: string): boolean {
    return this.functions.has(name);
  }

  /**
   * Get all registered functions
   *
   * Returns a copy of the internal map to prevent external modification.
   * This is important to maintain encapsulation and prevent accidental mutations.
   *
   * @returns Copy of the internal function map
   */
  getAll(): Map<string, FunctionDefinition> {
    // Return a new Map to prevent external modification of internal state
    return new Map(this.functions);
  }
}
