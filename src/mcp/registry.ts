import type { IConnector } from './interfaces/connector.interface';
import type { ConnectorId, ConnectorMeta } from '../types/mcp.types';
import { ConnectorError } from '../types/mcp.types';
import { SlackConnector } from './connectors/slack.connector';
import { logger } from '../utils/logger';

/**
 * ConnectorRegistry — the central registry for all MCP connectors.

 * The registry is a singleton — import { registry } directly.
 */
class ConnectorRegistry {
  private readonly connectors = new Map<ConnectorId, IConnector>();

  /**
   * Registers a connector instance.
   * Overwrites any existing connector with the same ID (useful for testing).
   */
  register(connector: IConnector): void {
    const meta = connector.getMeta();
    this.connectors.set(meta.id, connector);
    logger.info({ connectorId: meta.id, version: meta.version }, '[Registry] Connector registered');
  }

  /**
   * Returns a connector by ID.
   * Throws if the connector is not registered.
   */
  get(id: ConnectorId): IConnector {
    const connector = this.connectors.get(id);

    if (!connector) {
      throw new ConnectorError(
        `Connector "${id}" is not registered. Available: [${this.list().join(', ')}]`,
        'CONNECTOR_NOT_FOUND',
        id,
        404
      );
    }

    return connector;
  }

  /**
   * Returns true if a connector with this ID is registered.
   */
  has(id: ConnectorId): boolean {
    return this.connectors.has(id);
  }

  /**
   * Returns metadata for all registered connectors.
   */
  getAllMeta(): ConnectorMeta[] {
    return Array.from(this.connectors.values()).map((c) => c.getMeta());
  }

  /**
   * Returns all registered connector IDs.
   */
  list(): ConnectorId[] {
    return Array.from(this.connectors.keys());
  }

  /**
   * Removes a connector from the registry.
   * Mainly used in tests or for dynamic connector management.
   */
  unregister(id: ConnectorId): void {
    this.connectors.delete(id);
  }
}

// ─── Singleton instance ───────────────────────────────────────────────────────

export const registry = new ConnectorRegistry();

/**
 * Bootstrap — registers all connectors at startup.
 * Called once from app.ts before the server starts listening.
 *
 * Add new connectors here as you build them:
 *   registry.register(new DiscordConnector());
 *   registry.register(new NotionConnector());
 */
export function bootstrapConnectors(): void {
  registry.register(new SlackConnector());

  // Future connectors:
  // registry.register(new DiscordConnector());
  // registry.register(new NotionConnector());
  // registry.register(new GmailConnector());

  logger.info(
    { connectors: registry.list() },
    `[Registry] ${registry.list().length} connector(s) loaded`
  );
}
