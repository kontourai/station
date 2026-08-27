/**
 * Layout Service - handles layout CRUD operations
 */

import type { WorkflowMetadata } from '@kontourai/station-contracts/runtime';
import type { ConfigLoader } from '../../domain/config-loader.js';

export class LayoutService {
  constructor(
    private configLoader: ConfigLoader,
    _logger: any,
  ) {}

  // Workflow management (workflows are per-agent but related to layout functionality)
  async listAgentWorkflows(agentSlug: string): Promise<WorkflowMetadata[]> {
    return this.configLoader.listAgentWorkflows(agentSlug);
  }

  async getWorkflow(agentSlug: string, workflowId: string): Promise<string> {
    return this.configLoader.readWorkflow(agentSlug, workflowId);
  }

  async createWorkflow(
    agentSlug: string,
    filename: string,
    content: string,
  ): Promise<void> {
    await this.configLoader.createWorkflow(agentSlug, filename, content);
  }

  async updateWorkflow(
    agentSlug: string,
    workflowId: string,
    content: string,
  ): Promise<void> {
    await this.configLoader.updateWorkflow(agentSlug, workflowId, content);
  }

  async deleteWorkflow(agentSlug: string, workflowId: string): Promise<void> {
    await this.configLoader.deleteWorkflow(agentSlug, workflowId);
  }
}
