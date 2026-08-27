import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import type { ISkillRegistryProvider } from '../provider-interfaces.js';

export class MultiSourceSkillRegistryProvider
  implements ISkillRegistryProvider
{
  constructor(private providers: ISkillRegistryProvider[]) {}

  async listAvailable(): Promise<RegistryItem[]> {
    const results = await Promise.all(
      this.providers.map(async (provider) => provider.listAvailable()),
    );
    const seen = new Set<string>();
    return results.flat().filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  async listInstalled(): Promise<RegistryItem[]> {
    const results = await Promise.all(
      this.providers.map(async (provider) => provider.listInstalled()),
    );
    const seen = new Set<string>();
    return results.flat().filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  async install(id: string, targetDir: string): Promise<InstallResult> {
    for (const provider of this.providers) {
      const result = await provider.install(id, targetDir);
      if (result.success) return result;
    }
    return {
      success: false,
      message: `No registry source could install ${id}`,
    };
  }

  async uninstall(id: string, targetDir: string): Promise<InstallResult> {
    for (const provider of this.providers) {
      const result = await provider.uninstall(id, targetDir);
      if (result.success) return result;
    }
    return {
      success: false,
      message: `No registry source could uninstall ${id}`,
    };
  }

  async getContent(id: string): Promise<string | null> {
    for (const provider of this.providers) {
      const content = await provider.getContent?.(id);
      if (content) return content;
    }
    return null;
  }
}
