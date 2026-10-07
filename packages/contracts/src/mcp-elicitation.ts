/**
 * A form-mode MCP elicitation (`elicitation/create`) a tool server sent while a
 * Station turn was running, normalized to the field subset Station renders.
 *
 * The MCP schema is deliberately restricted to a flat object of primitive
 * fields; Station supports exactly that subset and refuses anything else
 * rather than rendering part of a form.
 */
export interface McpElicitationForm {
  /** The tool server that asked. */
  serverId: string;
  message: string;
  fields: McpElicitationField[];
}

interface McpElicitationFieldBase {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
}

export type McpElicitationStringFormat = 'email' | 'uri' | 'date' | 'date-time';

export interface McpElicitationStringField extends McpElicitationFieldBase {
  kind: 'string';
  minLength?: number;
  maxLength?: number;
  format?: McpElicitationStringFormat;
  default?: string;
}

export interface McpElicitationNumberField extends McpElicitationFieldBase {
  kind: 'number' | 'integer';
  minimum?: number;
  maximum?: number;
  default?: number;
}

export interface McpElicitationBooleanField extends McpElicitationFieldBase {
  kind: 'boolean';
  default?: boolean;
}

export interface McpElicitationOption {
  value: string;
  label: string;
}

export interface McpElicitationChoiceField extends McpElicitationFieldBase {
  kind: 'choice';
  options: McpElicitationOption[];
  default?: string;
}

export interface McpElicitationMultiChoiceField
  extends McpElicitationFieldBase {
  kind: 'multi-choice';
  options: McpElicitationOption[];
  minItems?: number;
  maxItems?: number;
  default?: string[];
}

export type McpElicitationField =
  | McpElicitationStringField
  | McpElicitationNumberField
  | McpElicitationBooleanField
  | McpElicitationChoiceField
  | McpElicitationMultiChoiceField;

export type McpElicitationValue = string | number | boolean | string[];

/** Accepted form content, keyed by field name. */
export type McpElicitationContent = Record<string, McpElicitationValue>;

/** The truthful answer returned to the tool server. */
export type McpElicitationResult =
  | { action: 'accept'; content: McpElicitationContent }
  | { action: 'decline' }
  | { action: 'cancel' };
