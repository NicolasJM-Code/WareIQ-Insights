export function startOpenVpnFixture(options: {
  certFile: string;
  keyFile: string;
  mysqlPort: number;
}): Promise<{
  token: string;
  port: number;
  close: () => Promise<void>;
}>;
