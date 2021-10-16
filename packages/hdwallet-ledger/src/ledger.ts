import * as core from "@shapeshiftoss/hdwallet-core";
import _ from "lodash";

import * as btc from "./bitcoin";
import * as eth from "./ethereum";
import { LedgerTransport } from "./transport";
import { coinToLedgerAppName, handleError } from "./utils";

// Special non-BIP-44 path descriptions for Ledger.
function ethDescribeLedgerPath(path: core.BIP32Path): core.PathDescription {
  let pathStr = core.addressNListToBIP32(path);
  let unknown: core.PathDescription = {
    verbose: pathStr,
    coin: "Ethereum",
    isKnown: false,
  };

  if (path.length !== 5 && path.length !== 4) return unknown;

  if (path[0] !== 0x80000000 + 44) return unknown;

  if (path[1] !== 0x80000000 + core.slip44ByCoin("Ethereum")) return unknown;

  if ((path[2] & 0x80000000) >>> 0 !== 0x80000000) return unknown;

  let accountIdx;
  if (path.length === 5) {
    if (path[3] !== 0) return unknown;

    if (path[4] !== 0) return unknown;

    accountIdx = (path[2] & 0x7fffffff) >>> 0;
  } else if (path.length === 4) {
    if (path[2] !== 0x80000000) return unknown;

    if ((path[3] & 0x80000000) >>> 0 === 0x80000000) return unknown;

    accountIdx = path[3];
  } else {
    return unknown;
  }

  return {
    verbose: `Ethereum Account #${accountIdx}`,
    wholeAccount: true,
    accountIdx,
    coin: "Ethereum",
    isKnown: true,
    isPrefork: false,
  };
}

export class LedgerHDWalletInfo implements core.HDWalletInfo, core.BTCWalletInfo, core.ETHWalletInfo {
  readonly _supportsBTCInfo = true;
  readonly _supportsETHInfo = true;

  public getVendor(): string {
    return "Ledger";
  }

  public async btcSupportsCoin(coin: core.Coin): Promise<boolean> {
    return btc.btcSupportsCoin(coin);
  }

  public async btcSupportsScriptType(coin: core.Coin, scriptType: core.BTCInputScriptType): Promise<boolean> {
    return btc.btcSupportsScriptType(coin, scriptType);
  }

  public async btcSupportsSecureTransfer(): Promise<boolean> {
    return btc.btcSupportsSecureTransfer();
  }

  public btcGetAccountPaths(msg: core.BTCGetAccountPaths): Array<core.BTCAccountPath> {
    return btc.btcGetAccountPaths(msg);
  }

  public btcIsSameAccount(msg: Array<core.BTCAccountPath>): boolean {
    return btc.btcIsSameAccount(msg);
  }

  public async ethSupportsNetwork(chain_id: number): Promise<boolean> {
    return eth.ethSupportsNetwork(chain_id);
  }

  public async ethSupportsSecureTransfer(): Promise<boolean> {
    return eth.ethSupportsSecureTransfer();
  }

  public async ethSupportsEIP1559(): Promise<boolean> {
    return eth.ethSupportsEIP1559();
  }

  public ethGetAccountPaths(msg: core.ETHGetAccountPath): Array<core.ETHAccountPath> {
    return eth.ethGetAccountPaths(msg);
  }

  public hasOnDeviceDisplay(): boolean {
    return true;
  }

  public hasOnDevicePassphrase(): boolean {
    return true;
  }

  public hasOnDevicePinEntry(): boolean {
    return true;
  }

  public hasOnDeviceRecovery(): boolean {
    return true;
  }

  public describePath(msg: core.DescribePath): core.PathDescription {
    if (msg.coin.toLowerCase() === "ethereum") return ethDescribeLedgerPath(msg.path);
    return core.describePath(msg);
  }

  public btcNextAccountPath(msg: core.BTCAccountPath): core.BTCAccountPath | undefined {
    let description = core.btcDescribePath(msg.addressNList, msg.coin, msg.scriptType);
    if (!description.isKnown) {
      return undefined;
    }

    let addressNList = msg.addressNList;

    if (
      addressNList[0] === 0x80000000 + 44 ||
      addressNList[0] === 0x80000000 + 49 ||
      addressNList[0] === 0x80000000 + 84
    ) {
      addressNList[2] += 1;
      return {
        ...msg,
        addressNList,
      };
    }

    return undefined;
  }

  public ethNextAccountPath(msg: core.ETHAccountPath): core.ETHAccountPath | undefined {
    let addressNList = msg.hardenedPath.concat(msg.relPath);
    let description = core.ethDescribePath(addressNList);
    if (!description.isKnown) {
      return undefined;
    }

    if (description.wholeAccount) {
      addressNList[2] += 1;
      return {
        ...msg,
        addressNList,
        hardenedPath: core.hardenedPath(addressNList),
        relPath: core.relativePath(addressNList),
      };
    }

    if (addressNList.length === 5) {
      addressNList[2] += 1;
      return {
        ...msg,
        hardenedPath: core.hardenedPath(addressNList),
        relPath: core.relativePath(addressNList),
      };
    }

    if (addressNList.length === 4) {
      addressNList[3] += 1;
      return {
        ...msg,
        hardenedPath: core.hardenedPath(addressNList),
        relPath: core.relativePath(addressNList),
      };
    }

    return undefined;
  }
}

export class LedgerHDWallet implements core.HDWallet, core.BTCWallet, core.ETHWallet {
  readonly _supportsETHInfo = true;
  readonly _supportsBTCInfo = true;
  readonly _supportsBTC = true;
  readonly _supportsETH = true;

  transport: LedgerTransport;
  info: LedgerHDWalletInfo & core.HDWalletInfo;

  constructor(transport: LedgerTransport) {
    this.transport = transport;
    this.info = new LedgerHDWalletInfo();
  }

  public async initialize(): Promise<boolean> {
    return await this.isInitialized();
  }

  public async isInitialized(): Promise<boolean> {
    // AFAICT, there isn't an API to figure this out, so we go with a reasonable
    // (ish) default:
    return true;
  }

  public async getDeviceID(): Promise<string> {
    const {
      device: { serialNumber: deviceID },
    } = this.transport as any;
    return deviceID;
  }

  public async getFeatures(): Promise<any> {
    const res = await this.transport.call(null, "getDeviceInfo");
    handleError(res, this.transport);
    return res.payload;
  }

  /**
   * Validate if a specific app is open
   * Throws WrongApp error if app associated with coin is not open
   * @param coin  Name of coin for app name lookup
   */
  public async validateCurrentApp(coin?: core.Coin): Promise<void> {
    if (!coin) {
      throw new Error(`No coin provided`);
    }

    const appName = coinToLedgerAppName(coin);
    if (!appName) {
      throw new Error(`Unable to find associated app name for coin: ${coin}`);
    }

    const res = await this.transport.call(null, "getAppAndVersion");
    handleError(res, this.transport);

    const {
      payload: { name: currentApp },
    } = res;
    if (currentApp !== appName) {
      throw new core.WrongApp("Ledger", appName);
    }
  }

  /**
   * Prompt user to open given app on device
   * User must be in dashboard
   * @param appName - human-readable app name i.e. "Bitcoin Cash"
   */
  public async openApp(appName: string): Promise<void> {
    const res = await this.transport.call(null, "openApp", appName);
    handleError(res, this.transport);
  }

  public async getFirmwareVersion(): Promise<string> {
    const { version } = await this.getFeatures();
    return version;
  }

  public getVendor(): string {
    return "Ledger";
  }

  public async getModel(): Promise<string> {
    const {
      device: { productName },
    } = this.transport as any;
    return productName;
  }

  public async getLabel(): Promise<string> {
    return "Ledger";
  }

  public async isLocked(): Promise<boolean> {
    return true;
  }

  public async clearSession(): Promise<void> {
    return;
  }

  public async getPublicKeys(msg: Array<core.GetPublicKey>): Promise<Array<core.PublicKey | null>> {
    const res = await this.transport.call(null, "getAppAndVersion");
    handleError(res, this.transport);

    const {
      payload: { name },
    } = res;

    const btcApps = new Set(btc.supportedCoins.map(x => coinToLedgerAppName(x)).filter(x => x !== undefined))
    if (btcApps.has(name)) return btc.btcGetPublicKeys(this.transport, msg);

    switch (name) {
      case "Ethereum":
        return eth.ethGetPublicKeys(this.transport, msg);
      default:
        throw new Error(`getPublicKeys is not supported with the ${name} app`);
    }
  }

  public hasOnDeviceDisplay(): boolean {
    return true;
  }

  public hasOnDevicePassphrase(): boolean {
    return true;
  }

  public hasOnDevicePinEntry(): boolean {
    return true;
  }

  public hasOnDeviceRecovery(): boolean {
    return true;
  }

  public async loadDevice(msg: core.LoadDevice): Promise<void> {
    return;
  }

  // Ledger doesn't have this, faking response here
  public async ping(msg: core.Ping): Promise<core.Pong> {
    return { msg: msg.msg };
  }

  public async cancel(): Promise<void> {
    return;
  }

  public async recover(msg: core.RecoverDevice): Promise<void> {
    return;
  }

  public async reset(msg: core.ResetDevice): Promise<void> {
    return;
  }

  public async sendCharacter(character: string): Promise<void> {
    return;
  }

  public async sendPassphrase(passphrase: string): Promise<void> {
    return;
  }

  public async sendPin(pin: string): Promise<void> {
    return;
  }

  public async sendWord(word: string): Promise<void> {
    return;
  }

  public async wipe(): Promise<void> {
    return;
  }

  public async btcSupportsCoin(coin: core.Coin): Promise<boolean> {
    return this.info.btcSupportsCoin(coin);
  }

  public async btcSupportsScriptType(coin: core.Coin, scriptType: core.BTCInputScriptType): Promise<boolean> {
    return this.info.btcSupportsScriptType(coin, scriptType);
  }

  public async btcGetAddress(msg: core.BTCGetAddress): Promise<string> {
    await this.validateCurrentApp(msg.coin);
    return btc.btcGetAddress(this.transport, msg);
  }

  public async btcSignTx(msg: core.BTCSignTxLedger): Promise<core.BTCSignedTx> {
    await this.validateCurrentApp(msg.coin);
    return btc.btcSignTx(this, this.transport, msg);
  }

  public async btcSupportsSecureTransfer(): Promise<boolean> {
    return this.info.btcSupportsSecureTransfer();
  }

  public async btcSignMessage(msg: core.BTCSignMessage): Promise<core.BTCSignedMessage> {
    await this.validateCurrentApp(msg.coin);
    return btc.btcSignMessage(this, this.transport, msg);
  }

  public async btcVerifyMessage(msg: core.BTCVerifyMessage): Promise<boolean> {
    return btc.btcVerifyMessage(msg);
  }

  public btcGetAccountPaths(msg: core.BTCGetAccountPaths): Array<core.BTCAccountPath> {
    return this.info.btcGetAccountPaths(msg);
  }

  public btcIsSameAccount(msg: Array<core.BTCAccountPath>): boolean {
    return this.info.btcIsSameAccount(msg);
  }

  public async ethSignTx(msg: core.ETHSignTx): Promise<core.ETHSignedTx> {
    await this.validateCurrentApp("Ethereum");
    return eth.ethSignTx(this.transport, msg);
  }

  public async ethGetAddress(msg: core.ETHGetAddress): Promise<string> {
    await this.validateCurrentApp("Ethereum");
    return eth.ethGetAddress(this.transport, msg);
  }

  public async ethSignMessage(msg: core.ETHSignMessage): Promise<core.ETHSignedMessage> {
    await this.validateCurrentApp("Ethereum");
    return eth.ethSignMessage(this.transport, msg);
  }

  public async ethVerifyMessage(msg: core.ETHVerifyMessage): Promise<boolean> {
    return eth.ethVerifyMessage(msg);
  }

  public async ethSupportsNetwork(chain_id: number): Promise<boolean> {
    return this.info.ethSupportsNetwork(chain_id);
  }

  public async ethSupportsSecureTransfer(): Promise<boolean> {
    return this.info.ethSupportsSecureTransfer();
  }

  public async ethSupportsEIP1559(): Promise<boolean> {
    return await this.info.ethSupportsEIP1559();
  }

  public ethGetAccountPaths(msg: core.ETHGetAccountPath): Array<core.ETHAccountPath> {
    return this.info.ethGetAccountPaths(msg);
  }

  public describePath(msg: core.DescribePath): core.PathDescription {
    return this.info.describePath(msg);
  }

  public disconnect(): Promise<void> {
    return this.transport.disconnect();
  }

  public btcNextAccountPath(msg: core.BTCAccountPath): core.BTCAccountPath | undefined {
    return this.info.btcNextAccountPath(msg);
  }

  public ethNextAccountPath(msg: core.ETHAccountPath): core.ETHAccountPath | undefined {
    return this.info.ethNextAccountPath(msg);
  }
}

export function info(): LedgerHDWalletInfo {
  return new LedgerHDWalletInfo();
}

export function create(transport: LedgerTransport): LedgerHDWallet {
  return new LedgerHDWallet(transport);
}
