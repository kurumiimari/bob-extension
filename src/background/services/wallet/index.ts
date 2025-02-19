import {GenericService} from "@src/util/svc";
const Mnemonic = require('hsd/lib/hd/mnemonic');
const WalletDB = require("hsd/lib/wallet/walletdb");
const Network = require("hsd/lib/protocol/network");
const Covenant = require("hsd/lib/primitives/covenant");
const rules = require("hsd/lib/covenants/rules");
const {states} = require("hsd/lib/covenants/namestate");
const Address = require("hsd/lib/primitives/address");
const TX = require("hsd/lib/primitives/tx");
const NameState = require("hsd/lib/covenants/namestate");
const common = require("hsd/lib/wallet/common");
const ChainEntry = require("hsd/lib/blockchain/chainentry");
const MTX = require("hsd/lib/primitives/mtx");
const Output = require('hsd/lib/primitives/output');
const Outpoint = require("hsd/lib/primitives/outpoint");
const MasterKey = require('hsd/lib/wallet/masterkey');
const BN = require('bcrypto/lib/bn.js');
const bdb = require('bdb');
const DB = require('bdb/lib/DB');
const layout = require('hsd/lib/wallet/layout').txdb;
const {Resource} = require('hsd/lib/dns/resource');
import {get, put} from '@src/util/db';
import pushMessage from "@src/util/pushMessage";
import {ActionType as WalletActionType, setWalletBalance} from "@src/ui/ducks/wallet";
import {ActionType as AppActionType} from "@src/ui/ducks/app";
import {ActionType, setTransactions, Transaction} from "@src/ui/ducks/transactions";
import {ActionTypes, setDomainNames} from "@src/ui/ducks/domains";
import {ActionType as QueueActionType, setTXQueue } from "@src/ui/ducks/queue";
import {toDollaryDoos} from "@src/util/number";
import BlindBid from "@src/background/services/wallet/blind-bid";
import BidReveal from "@src/background/services/wallet/bid-reveal";
import {UpdateRecordType} from "@src/contentscripts/bob3";
import {getBidBlind, getTXAction} from "@src/util/transaction";
import {setInfo} from "@src/ui/ducks/node";
const {types, typesByVal} = rules;
const bsocket = require("bsock");

const networkType = process.env.NETWORK_TYPE || 'main';
const ACCOUNT_DEPTH = 100;

export default class WalletService extends GenericService {
  network: typeof Network;

  wdb: typeof WalletDB;

  store: typeof DB;

  transactions?: any[] | null;

  domains?: any[] | null;

  socket?: typeof bsocket.Socket;

  selectedID: string;

  locked: boolean;

  rescanning: boolean;

  checkStatusTimeout?: any;

  _getTxNonce: number;

  _getNameNonce: number;

  forceStopRescan: boolean;

  private passphrase: string | undefined;

  constructor() {
    super();
    this.selectedID = '';
    this.locked = true;
    this.rescanning = false;
    this.forceStopRescan = false;
    this._getTxNonce = 0;
    this._getNameNonce = 0;
  }

  lockWallet = async () => {
    const wallet = await this.wdb.get(this.selectedID);
    await wallet.lock();
    this.emit('locked');
    this.passphrase = undefined;
    this.locked = true;
  };

  unlockWallet = async (password: string) => {
    const wallet = await this.wdb.get(this.selectedID);
    await wallet.unlock(password, 60000);
    this.passphrase = password;
    this.locked = false;
    await wallet.lock();
    this.emit('unlocked', this.selectedID);
  };


  getState = async () => {
    const tip = await this.wdb.getTip();
    return {
      selectedID: this.selectedID,
      locked: this.locked,
      tip: {
        hash: tip.hash.toString('hex'),
        height: tip.height,
        time: tip.time,
      },
      rescanning: this.rescanning,
    };
  };

  getWalletInfo = async (id?: string) => {
    const walletId = id || this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const balance = await wallet.getBalance();
    return wallet.getJSON(false, balance);
  };

  pushState = async () => {
    const walletState = await this.getState();
    await pushMessage({
      type: WalletActionType.SET_WALLET_STATE,
      payload: walletState,
    });
  };

  pushBobMessage = async (message: string) => {
    await pushMessage({
      type: AppActionType.SET_BOB_MESSAGE,
      payload: message,
    });
  };

  async generateNewMnemonic() {
    return new Mnemonic({ bits: 256 }).getPhrase().trim();
  }

  selectWallet = async (id: string) => {
    const walletIDs = await this.getWalletIDs();

    if (!walletIDs.includes(id)) {
      throw new Error(`Cannot find wallet - ${id}`)
    }

    if (this.selectedID !== id) {
      const wallet = await this.wdb.get(id);
      await wallet.lock();
      this.emit('locked');
      this.transactions = null;
      this.domains = null;
      this.locked = true;
      await this.pushState();
      await pushMessage(setTransactions([]));
      await pushMessage(setDomainNames([]));
      await pushMessage(setTXQueue([]));
      try {
        await pushMessage(setWalletBalance(await this.getWalletBalance()));
      } catch (e) {
        console.error(e);
      }
    }

    this.selectedID = id;
  };

  getWalletIDs = async (): Promise<string[]> => {
    return this.wdb.getWallets();
  };

  getWalletReceiveAddress = async (options: {id?: string; depth: number} = { depth: -1 }) => {
    const wallet = await this.wdb.get(options.id || this.selectedID);
    const account = await wallet.getAccount('default');
    return account
      .deriveReceive(
        options.depth > -1 ? options.depth : account.receiveDepth - 1
      )
      .getAddress()
      .toString(this.network);
  };

  getWalletBalance = async (id?: string) => {
    const walletId = id || this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const balance = await wallet.getBalance();
    return wallet.getJSON(false, balance).balance;
  };

  getPendingTransactions = async (id: string, shouldBroadcast = true) => {
    const walletId = id || this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const wtxs = await wallet.getPending();
    const txs = [];

    for (const wtx of wtxs) {
      if (!wtx.tx.isCoinbase()){
        txs.push(wtx.tx);
      }
    }

    const sorted = common.sortDeps(txs);

    await this._addPrevoutCoinToPending(txs);

    if (shouldBroadcast) {
      for (const tx of sorted) {
        await this.exec('node', 'sendRawTransaction', tx.toHex());
      }
    }

    return txs;
  };

  revealSeed = async (passphrase: string) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const data = await wallet.master.getJSON(this.network, true);

    // should always be encrypted - seed cannot be revealed via the UI until
    // the user has finished onboarding. checking here for completeness' sake
    if (!data.encrypted) {
      return data.key.mnemonic.phrase;
    }

    const parsedData = {
      encrypted: data.encrypted,
      alg: data.algorithm,
      iv: Buffer.from(data.iv, 'hex'),
      ciphertext: Buffer.from(data.ciphertext, 'hex'),
      n: data.n,
      r: data.r,
      p: data.p,
    };

    const mk = new MasterKey(parsedData);
    await mk.unlock(passphrase, 100);
    return mk.mnemonic.getPhrase();
  };

  resetNames = async () => {
    this._getNameNonce++;
  };

  getTransactions = async (opts?: {id?: string, offset: number}) => {
    const {
      id,
    } = opts || {};
    const walletId = id || this.selectedID;
    const wallet = await this.wdb.get(walletId);

    if (this.transactions?.length) {
      await pushMessage({
        type: ActionType.SET_TRANSACTIONS,
        payload: this.transactions,
      });
    }

    const latestBlock = await this.exec('node', 'getLatestBlock');

    const txs = await wallet.getHistory('default');

    if (txs.length === this.transactions?.length) {
      return this.transactions;
    }

    common.sortTX(txs);

    const details = await wallet.toDetails(txs);

    const transactions = [];


    let i = 0;
    for (const item of details) {
      this.pushBobMessage(`Loading ${++i} of ${details.length} TX...`);
      const json: Transaction = item.getJSON(this.network, latestBlock.height);
      const action = getTXAction(json);
      const blind = action === 'BID' && getBidBlind(json);

      if (blind) {
        const bv = await wallet.txdb.getBlind(Buffer.from(blind, 'hex'));
        json.blind = bv;
      }

      transactions.push(json);
    }

    this.transactions = transactions.reverse();
    this.pushBobMessage('');
    return this.transactions;
  };

  getCoin = async (hash: string, index: number) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    return wallet.getCoin(Buffer.from(hash, 'hex'), index);
  }

  getDomainName = async (name: string) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const res = await this.exec('node', 'getNameInfo', name);
    const { result } = res || {};
    const { info } = result || {};

    const {owner} = info;
    const coin = await wallet.getCoin(Buffer.from(owner.hash, 'hex'), owner.index);

    return {
      ...info,
      owned: !!coin,
      ownerCovenantType: typesByVal[coin?.covenant.type],
    }
  };

  getDomainNames = async (opts?: {id?: string, nonce: number}) => {
    const {
      id,
    } = opts || {};
    const walletId = id || this.selectedID;
    const wallet = await this.wdb.get(walletId);

    if (this.domains?.length) {
      await pushMessage({
        type: ActionTypes.SET_DOMAIN_NAMES,
        payload: this.domains,
      });
    }

    let domains = await wallet.getNames();

    const latestBlock = await this.exec('node', 'getLatestBlock');

    domains = Object.keys(domains).map((name: string) => domains[name]);

    domains = domains.sort((a: any, b: any) => {
      if (a.renewal > b.renewal) return 1;
      if (b.renewal > a.renewal) return -1;
      return 0;
    });

    const result = [];

    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i];
      const {owner} = domain;
      const state = domain.state(latestBlock?.height, this.network);

      const coin = await wallet.getCoin(owner.hash, owner.index);

      if (!coin) {
        continue;
      }

      if (state !== 4) {
        continue;
      }

      result.push({
        ...domain.format(latestBlock?.height, this.network),
        owned: !!coin,
        ownerCovenantType: typesByVal[coin.covenant.type],
      });
    }

    this.domains = result;

    await pushMessage({
      type: ActionTypes.SET_DOMAIN_NAMES,
      payload: this.domains,
    });

    return true;
  };

  getBidsByName = async (name: string) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);

    if (!name) throw new Error('name must not be empty');

    const bids = await wallet.getBids();
    return bids;
  };

  addNameState = async (name: string) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const nameInfo = await this.exec('node', 'getNameInfo', name);

    if (!nameInfo || !nameInfo.result) throw new Error('cannot get name info');
    const ns = new NameState().fromJSON(nameInfo.result.info);

    const b = wallet.txdb.bucket.batch();

    const {nameHash} = ns;

    if (ns.isNull()) {
      b.del(layout.A.encode(nameHash));
    } else {
      b.put(layout.A.encode(nameHash), ns.encode());
    }

    await b.write();
  };

  getNonce = async (nameHash: string, addr: string, bid: number) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const address = Address.fromString(addr, this.network);

    const name = await this.exec('node', 'getNameByHash', nameHash);
    const nameHashBuf = Buffer.from(nameHash, 'hex');
    const nonce = await wallet.generateNonce(nameHashBuf, address, bid);
    const blind = rules.blind(bid, nonce);

    return {
      address: address.toString(this.network),
      blind: blind.toString('hex'),
      nonce: nonce.toString('hex'),
      bid: bid,
      name: name,
      nameHash: nameHash,
    };
  };

  importNonce = async (nameHash: string, addr: string, value: number) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);

    if (!nameHash)
      throw new Error('Invalid name.');

    if (addr == null)
      throw new Error('Invalid value.');

    if (value == null)
      throw new Error('Invalid value.');

    const nameHashBuf = Buffer.from(nameHash, 'hex');
    const address = Address.fromString(addr, this.network);

    const blind = await wallet.generateBlind(nameHashBuf, address, value);

    return blind.toString('hex');
  };

  createWallet = async (options: {
    id: string;
    passphrase: string;
    mnemonic: string;
    optIn: boolean;
  }) => {
    await this.exec('setting', 'setAnalytics', options.optIn);
    const wallet = await this.wdb.create(options);
    const balance = await wallet.getBalance();
    await this.selectWallet(options.id);
    await this.unlockWallet(options.passphrase);
    return wallet.getJSON(false, balance);
  };

  createReveal = async (opts: {name: string; rate?: number}) => {
    const {name, rate} = opts || {};
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const latestBlockNow = await this.exec('node', 'getLatestBlock');

    this.wdb.height = latestBlockNow.height;

    if (name && !rules.verifyName(name)) {
      throw new Error('Invalid name.');
    }

    const rawName = name && Buffer.from(name, 'ascii');
    const inputNameHash = name && rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    const iter = wallet.txdb.bucket.iterator({
      gte: inputNameHash ? layout.i.min(inputNameHash) : layout.i.min(),
      lte: inputNameHash ? layout.i.max(inputNameHash) : layout.i.max(),
      values: true
    });

    const iter2 = wallet.txdb.bucket.iterator({
      gte: inputNameHash ? layout.i.min(inputNameHash) : layout.i.min(),
      lte: inputNameHash ? layout.i.max(inputNameHash) : layout.i.max(),
      values: true
    });

    const raws = await iter.values();
    const keys = await iter2.keys();
    const bids: any[] = [];

    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      const key = keys[i];
      const [nameHash, hash, index] = layout.i.decode(key);

      const ns = await wallet.getNameState(nameHash);

      if (!ns) {
        throw new Error('Auction not found.');
      }

      ns.maybeExpire(height, network);

      const state = ns.state(height, network);

      if (state < states.REVEAL) {
        continue;
      }

      if (state > states.REVEAL) {
        continue;
      }

      const bb = BlindBid.decode(raw);

      bb.nameHash = nameHash;
      bb.prevout = new Outpoint(hash, index);

      const bv = await wallet.txdb.getBlind(bb.blind);

      if (bv)
        bb.value = bv.value;

      bids.push(bb);
    }

    const mtx = new MTX();

    for (const {prevout, own} of bids) {
      if (!own)
        continue;

      const {hash, index} = prevout;
      const coin = await wallet.getCoin(hash, index);

      if (!coin) {
        continue;
      }

      if (!await wallet.txdb.hasCoinByAccount(0, hash, index)) {
        continue;
      }

      const nameHash = rules.hashName(coin.covenant.items[2].toString('utf-8'));
      const ns = await wallet.getNameState(nameHash);

      if (!ns) {
        throw new Error('Auction not found.');
      }

      ns.maybeExpire(height, network);

      const state = ns.state(height, network);

      if (state < states.REVEAL) {
        continue;
      }

      if (state > states.REVEAL) {
        continue;
      }

      // Is local?
      if (coin.height < ns.height) {
        continue;
      }

      const blind = coin.covenant.getHash(3);
      const bv = await wallet.getBlind(blind);

      if (!bv) {
        throw new Error('Blind value not found.');
      }

      const {value, nonce} = bv;

      const output = new Output();
      output.address = coin.address;
      output.value = value;
      output.covenant.type = types.REVEAL;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);
      output.covenant.pushHash(nonce);

      mtx.addOutpoint(prevout);
      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0) {
      throw new Error('No bids to reveal.');
    }

    await wallet.fill(mtx, rate && { rate });
    const createdTx = await wallet.finalize(mtx);
    return createdTx.toJSON();
  };

  createRedeem = async (opts: {name: string; rate?: number}) => {
    const {name, rate} = opts;
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const latestBlockNow = await this.exec('node', 'getLatestBlock');
    await this.addNameState(name);
    this.wdb.height = latestBlockNow.height;

    if (!rules.verifyName(name)) {
      throw new Error('Invalid name.');
    }

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await wallet.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns) {
      throw new Error('Auction not found.');
    }

    if (ns.isExpired(height, network)) {
      throw new Error('Name has expired!');
    }

    const state = ns.state(height, network);

    if (state < states.CLOSED) {
      throw new Error('Auction is not yet closed.');
    }

    const iter = wallet.txdb.bucket.iterator({
      gte: nameHash ? layout.B.min(nameHash) : layout.B.min(),
      lte: nameHash ? layout.B.max(nameHash) : layout.B.max(),
      values: true
    });

    const iter2 = wallet.txdb.bucket.iterator({
      gte: nameHash ? layout.B.min(nameHash) : layout.B.min(),
      lte: nameHash ? layout.B.max(nameHash) : layout.B.max(),
      values: true
    });

    const raws = await iter.values();
    const keys = await iter2.keys();
    const reveals: any[] = [];

    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      const key = keys[i];
      const [nameHash, hash, index] = layout.B.decode(key);
      const brv = BidReveal.decode(raw);
      brv.nameHash = nameHash;
      brv.prevout = new Outpoint(hash, index);
      reveals.push(brv);
    }

    const mtx = new MTX();

    for (const {prevout, own} of reveals) {
      if (!own)
        continue;

      // Winner can not redeem
      if (prevout.equals(ns.owner))
        continue;

      const {hash, index} = prevout;
      const coin = await wallet.getCoin(hash, index);

      if (!coin) {
        continue;
      }

      if (!await wallet.txdb.hasCoinByAccount(0, hash, index)) {
        continue;
      }

      // Is local?
      if (coin.height < ns.height) {
        continue;
      }

      mtx.addOutpoint(prevout);

      const output = new Output();
      output.address = coin.address;
      output.value = coin.value;
      output.covenant.type = types.REDEEM;
      output.covenant.pushHash(nameHash);
      output.covenant.pushU32(ns.height);

      mtx.outputs.push(output);
    }

    if (mtx.outputs.length === 0) {
      throw new Error('No reveals to redeem.');
    }

    await wallet.fill(mtx, rate && { rate });
    const createdTx = await wallet.finalize(mtx);
    return createdTx.toJSON();
  };

  createRegister = async (opts: {
    name: string,
    data: {
      records: UpdateRecordType[];
    },
    rate?: number,
  }) => {
    const {name, data, rate} = opts;
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const resource = Resource.fromJSON(data);

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await wallet.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const {hash, index} = ns.owner;
    const coin = await wallet.getCoin(hash, index);

    if (!coin)
      throw new Error('Wallet did not win the auction.');

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < ns.height)
      throw new Error('Wallet did not win the auction.');

    if (!coin.covenant.isReveal() && !coin.covenant.isClaim())
      throw new Error('Name must be in REVEAL or CLAIM state.');

    if (coin.covenant.isClaim()) {
      if (height < coin.height + network.coinbaseMaturity)
        throw new Error('Claim is not yet mature.');
    }

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    const output = new Output();
    output.address = coin.address;
    output.value = ns.value;

    output.covenant.type = types.REGISTER;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);

    if (resource) {
      const raw = resource.encode();

      if (raw.length > rules.MAX_RESOURCE_SIZE)
        throw new Error('Resource exceeds maximum size.');

      output.covenant.push(raw);
    } else {
      output.covenant.push(Buffer.alloc(0));
    }

    let renewalHeight = height - this.network.names.renewalMaturity * 2;

    if (height < 0)
      renewalHeight = 0;

    const renewalBlock = await this.exec('node', 'getBlockByHeight', renewalHeight);

    output.covenant.pushHash(Buffer.from(renewalBlock.hash, 'hex'));

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    await wallet.fill(mtx, rate && { rate: rate });
    const createdTx = await wallet.finalize(mtx);
    return createdTx.toJSON();
  };

  createUpdate = async (opts: {
    name: string,
    data: {
      records: UpdateRecordType[];
    },
    rate?: number,
  }) => {
    const {name, data, rate} = opts;
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const latestBlockNow = await this.exec('node', 'getLatestBlock');
    this.wdb.height = latestBlockNow.height;

    await this.addNameState(name);

    const resource = Resource.fromJSON(data);

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const ns = await wallet.getNameState(nameHash);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (!ns)
      throw new Error('Auction not found.');

    const {hash, index} = ns.owner;
    const coin = await wallet.getCoin(hash, index);

    if (!coin)
      throw new Error(`Wallet does not own: "${name}".`);

    if (!await wallet.txdb.hasCoinByAccount(0, hash, index))
      throw new Error(`Account does not own: "${name}".`);

    if (coin.covenant.isReveal() || coin.covenant.isClaim())
      return this.createRegister(opts);

    if (ns.isExpired(height, network))
      throw new Error('Name has expired!');

    // Is local?
    if (coin.height < ns.height)
      throw new Error(`Wallet does not own: "${name}".`);

    const state = ns.state(height, network);

    if (state !== states.CLOSED)
      throw new Error('Auction is not yet closed.');

    if (!coin.covenant.isRegister()
      && !coin.covenant.isUpdate()
      && !coin.covenant.isRenew()
      && !coin.covenant.isFinalize()) {
      throw new Error('Name must be registered.');
    }

    const raw = resource.encode();

    if (raw.length > rules.MAX_RESOURCE_SIZE)
      throw new Error('Resource exceeds maximum size.');

    const output = new Output();
    output.address = coin.address;
    output.value = coin.value;
    output.covenant.type = types.UPDATE;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(ns.height);
    output.covenant.push(raw);

    const mtx = new MTX();
    mtx.addOutpoint(ns.owner);
    mtx.outputs.push(output);

    await wallet.fill(mtx, rate && { rate: rate });
    const createdTx = await wallet.finalize(mtx);
    return createdTx.toJSON();
  };

  createOpen = async (opts: {
    name: string,
    rate?: number,
  }) => {
    const { name, rate } = opts;
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const latestBlockNow = await this.exec('node', 'getLatestBlock');
    this.wdb.height = latestBlockNow.height;

    if (!rules.verifyName(name))
      throw new Error('Invalid name.');

    const rawName = Buffer.from(name, 'ascii');
    const nameHash = rules.hashName(rawName);
    const height = this.wdb.height + 1;
    const network = this.network;

    if (rules.isReserved(nameHash, height, network))
      throw new Error('Name is reserved.');

    if (!rules.hasRollout(nameHash, height, network))
      throw new Error('Name not yet available.');

    const nameInfo = await this.exec('node', 'getNameInfo', name);

    if (!nameInfo || !nameInfo.result) throw new Error('cannot get name info');

    if (nameInfo.result.info) {
      throw new Error('Name is already opened.');
    }

    await this.exec('node', 'addNameHash', name, nameHash.toString('hex'));

    const addr = await wallet.receiveAddress(0);

    const output = new Output();
    output.address = addr;
    output.value = 0;
    output.covenant.type = types.OPEN;
    output.covenant.pushHash(nameHash);
    output.covenant.pushU32(0);
    output.covenant.push(rawName);

    const mtx = new MTX();
    mtx.outputs.push(output);

    if (await wallet.txdb.isDoubleOpen(mtx))
      throw new Error(`Already sent an open for: ${name}.`);

    await wallet.fill(mtx, rate && { rate: rate });
    const createdTx = await wallet.finalize(mtx);
    return createdTx.toJSON();
  };

  createBid = async (opts: {
    name: string,
    amount: number,
    lockup: number,
    feeRate?: number,
  }) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const latestBlockNow = await this.exec('node', 'getLatestBlock');
    this.wdb.height = latestBlockNow.height;

    await this.addNameState(opts.name);

    const createdTx = await wallet.createBid(
      opts.name,
      +toDollaryDoos(opts.amount),
      +toDollaryDoos(opts.lockup),
      opts.feeRate && {
        rate: opts.feeRate,
      },
    );
    return createdTx.toJSON();
  };

  createTx = async (txOptions: any) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const latestBlockNow = await this.exec('node', 'getLatestBlock');
    this.wdb.height = latestBlockNow.height;
    const mtx = MTX.fromJSON(txOptions);
    await wallet.fill(mtx);
    const createdTx = await wallet.finalize(mtx);
    return createdTx.toJSON();
  };

  createSend = async (txOptions: any) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const latestBlockNow = await this.exec('node', 'getLatestBlock');
    this.wdb.height = latestBlockNow.height;
    const createdTx = await wallet.createTX(txOptions);
    return createdTx.toJSON();
  };

  updateTxFromQueue = async (opts: {oldJSON: any; txJSON: any}) => {
    let txQueue = (await get(this.store,`tx_queue_${this.selectedID}`)) || [];
    txQueue = txQueue.map((tx: any) => {
      if (tx.hash === opts.oldJSON.hash) {
        return opts.txJSON;
      } else {
        return tx;
      }
    });
    await put(this.store,`tx_queue_${this.selectedID}`, txQueue);
    await this.updateTxQueue();
  };

  addTxToQueue = async (txJSON: any) => {
    const txQueue = (await get(this.store,`tx_queue_${this.selectedID}`)) || [];
    if (!txQueue.filter((tx: any) => tx.hash === txJSON.hash)[0]) {
      txQueue.push(txJSON);
    }
    await put(this.store,`tx_queue_${this.selectedID}`, txQueue);
    await this.updateTxQueue();
  };

  removeTxFromQueue = async (txJSON: any) => {
    let txQueue = (await get(this.store,`tx_queue_${this.selectedID}`)) || [];
    txQueue = txQueue.filter((tx: any) => tx.hash !== txJSON.hash);
    await put(this.store,`tx_queue_${this.selectedID}`, txQueue);
    await this.updateTxQueue();
  };

  getTxQueue = async (id?: string) => {
    const walletId = id || this.selectedID;
    const txQueue = (await get(this.store,`tx_queue_${walletId}`)) || [];
    await this._addOutputPathToTxQueue(txQueue);
    return txQueue;
  };

  rejectTx = async (txJSON: any) => {
    await this.removeTxFromQueue(txJSON);
    this.emit('txRejected', txJSON);
    const action = getTXAction(txJSON);
    this.exec('analytics', 'track', {
      name: 'Reject',
      data: {
        action,
      }
    });
  };

  submitTx = async (opts: {txJSON: Transaction; password: string}) => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);

    const action = getTXAction(opts.txJSON);

    this.exec('analytics', 'track', {
      name: 'Submit',
      data: {
        action,
      }
    });

    const latestBlockNow = await this.exec('node', 'getLatestBlock');
    this.wdb.height = latestBlockNow.height;
    const mtx = MTX.fromJSON(opts.txJSON);
    const tx = await wallet.sendMTX(mtx, this.passphrase);
    await this.removeTxFromQueue(opts.txJSON);
    await this.exec('node', 'sendRawTransaction', tx.toHex());
    const json = tx.getJSON(this.network);
    this.emit('txAccepted', json);
    return json;
  };

  async _addOutputPathToTxQueue(queue: Transaction[]): Promise<Transaction[]> {
    for (let i = 0; i < queue.length; i++) {
      const tx = queue[i];
      for (let outputIndex = 0; outputIndex < tx.outputs.length; outputIndex++) {
        const output = tx.outputs[outputIndex];
        output.owned = await this.hasAddress(output.address);
      }
    }

    return queue;
  }

  async _addPrevoutCoinToPending(pending: any[]): Promise<Transaction[]> {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    for (let i = 0; i < pending.length; i++) {
      const tx = pending[i];
      for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
        const input = tx.inputs[inputIndex];
        const coin = await wallet.getCoin(input.prevout.hash, input.prevout.index);
        input.coin = coin.getJSON(this.network);
      }
    }

    return pending;
  }

  updateTxQueue = async () => {
    if (this.selectedID) {
      const txQueue = await get(this.store,`tx_queue_${this.selectedID}`);
      await this._addOutputPathToTxQueue(txQueue);
      await pushMessage({
        type: QueueActionType.SET_TX_QUEUE,
        payload: txQueue || [],
      });
      return;
    }

    await pushMessage({
      type: QueueActionType.SET_TX_QUEUE,
      payload: [],
    });
  };

  insertTransactions = async (transactions: any[]) => {
    transactions = transactions.sort((a, b) => {
      if (a.height > b.height) return 1;
      if (b.height > a.height) return -1;
      if (a.index > b.index) return 1;
      if (b.index > a.index) return -1;
      return 0;
    });

    const txMap: {[hash: string]: string} = {};

    transactions = transactions.reduce((acc, tx) => {
      if (txMap[tx.hash]) return acc;
      txMap[tx.hash] = tx.hash;
      acc.push(tx);
      return acc;
    }, []);

    await this.pushBobMessage(`Found ${transactions.length} transaction.`);

    let retries = 0;
    for (let i = 0; i < transactions.length; i++) {
      if (this.forceStopRescan) {
        this.forceStopRescan = false;
        this.rescanning = false;
        await this.pushState();
        throw new Error('rescan stopped.');
      }
      const unlock = await this.wdb.txLock.lock();
      try {
        const tx = mapOneTx(transactions[i]);
        const wallet = await this.wdb.get(this.selectedID);
        const wtx = await wallet.getTX(Buffer.from(transactions[i].hash, 'hex'));

        await this.pushBobMessage(`Inserting TX # ${i} of ${transactions.length}....`);

        if (wtx && wtx.height > 0) {
          continue;
        }

        if (transactions[i].height <= 0) {
          continue;
        }

        const entryOption = await this.exec('node', 'getBlockEntry', transactions[i].height);
        const entry = new ChainEntry({
          ...entryOption,
          version: Number(entryOption.version),
          hash: Buffer.from(entryOption.hash, 'hex'),
          prevBlock: Buffer.from(entryOption.prevBlock, 'hex'),
          merkleRoot: Buffer.from(entryOption.merkleRoot, 'hex'),
          witnessRoot: Buffer.from(entryOption.witnessRoot, 'hex'),
          treeRoot: Buffer.from(entryOption.treeRoot, 'hex'),
          reservedRoot: Buffer.from(entryOption.reservedRoot, 'hex'),
          extraNonce: Buffer.from(entryOption.extraNonce, 'hex'),
          mask: Buffer.from(entryOption.mask, 'hex'),
          chainwork: entryOption.chainwork && BN.from(entryOption.chainwork, 16, 'be'),
        });

        await this.wdb._addTX(tx, entry);

        retries = 0;
      } catch (e) {
        retries++;

        await new Promise(r => setTimeout(r, 10));

        if (retries > 10000) {
          throw e;
        }

        i = Math.max(i - 2, 0);
      } finally {
        await unlock();
      }
    }
  };

  hasAddress = async (address: string): Promise<boolean> => {
    if (!address) {
      return false;
    }

    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);

    try {
      const key = await wallet.getKey(Address.from(address));
      return !!key;
    } catch (e) {
      return false;
    }
  };

  getAllReceiveTXs = async (startDepth = 0, endDepth = ACCOUNT_DEPTH, transactions: any[] = []): Promise<any[]> => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const account = await wallet.getAccount('default');
    const addresses = [];

    await this.pushBobMessage(`Scanning receive depth ${startDepth}-${endDepth}...`);

    let b;
    for (let i = startDepth; i < endDepth; i++) {
      if (this.forceStopRescan) {
        this.forceStopRescan = false;
        this.rescanning = false;
        await this.pushState();
        throw new Error('rescan stopped.');
      }
      const key = account.deriveReceive(i);
      const receive = key.getAddress().toString(this.network);
      const path = key.toPath();
      if (!await this.wdb.hasPath(account.wid, path.hash)) {
        b = b || this.wdb.db.batch();
        await this.wdb.savePath(b, account.wid, path);
      }
      addresses.push(receive);
    }

    if (b) {
      await b.write();
    }

    const newTXs = await this.exec('node', 'getTXByAddresses', addresses);

    if (!newTXs.length) {
      return transactions;
    }

    transactions = transactions.concat(newTXs);
    return await this.getAllReceiveTXs(startDepth + ACCOUNT_DEPTH, endDepth + ACCOUNT_DEPTH, transactions);
  };

  getAllChangeTXs = async (startDepth = 0, endDepth = ACCOUNT_DEPTH, transactions: any[] = []): Promise<any[]> => {
    const walletId = this.selectedID;
    const wallet = await this.wdb.get(walletId);
    const account = await wallet.getAccount('default');
    const addresses = [];

    await this.pushBobMessage(`Scanning change depth ${startDepth}-${endDepth}...`);

    let b;
    for (let i = startDepth; i < endDepth; i++) {
      if (this.forceStopRescan) {
        this.forceStopRescan = false;
        this.rescanning = false;
        await this.pushState();
        throw new Error('rescan stopped.');
      }
      const key = account.deriveChange(i);
      const change = key.getAddress().toString(this.network);
      const path = key.toPath();
      if (!await this.wdb.hasPath(account.wid, path.hash)) {
        b = b || this.wdb.db.batch();
        await this.wdb.savePath(b, account.wid, path);
      }
      addresses.push(change);
    }
    if (b) {
      await b.write();
    }
    const newTXs = await this.exec('node', 'getTXByAddresses', addresses);

    if (!newTXs.length) {
      return transactions;
    }

    transactions = transactions.concat(newTXs);
    return await this.getAllChangeTXs(startDepth + ACCOUNT_DEPTH, endDepth + ACCOUNT_DEPTH, transactions);
  };

  stopRescan = async () => {
    this.forceStopRescan = true;
    this.rescanning = false;
    this.pushState();
  };

  fullRescan = async () => {
    this.rescanning = true;
    this.pushState();
    await this.pushBobMessage('Start rescanning...');
    const latestBlockEnd = await this.exec('node', 'getLatestBlock');
    const changeTXs = await this.getAllChangeTXs();
    const receiveTXs = await this.getAllReceiveTXs();
    const transactions: any[] = receiveTXs.concat(changeTXs);
    await this.wdb.watch();
    await this.insertTransactions(transactions);
    await put(this.store,`latest_block_${this.selectedID}`, latestBlockEnd);
    this.rescanning = false;
    this.pushState();
    await this.pushBobMessage('');
    return;
  };

  processBlock = async (blockHeight: number) => {
    await this.pushBobMessage(`Fetching block # ${blockHeight}....`);

    const {
      txs: transactions,
      ...entryOption
    } = await this.exec('node', 'getBlockByHeight', blockHeight);

    await this.pushBobMessage(`Processing block # ${entryOption.height}....`);
    let retries = 0;

    for (let i = 0; i < transactions.length; i++) {
      const unlock = await this.wdb.txLock.lock();
      try {
        const tx = mapOneTx(transactions[i]);
        const wallet = await this.wdb.get(this.selectedID);
        const wtx = await wallet.getTX(Buffer.from(transactions[i].hash, 'hex'));
        if (wtx && wtx.height > 0) {
          continue;
        }

        const entry = new ChainEntry({
          ...entryOption,
          version: Number(entryOption.version),
          hash: Buffer.from(entryOption.hash, 'hex'),
          prevBlock: Buffer.from(entryOption.prevBlock, 'hex'),
          merkleRoot: Buffer.from(entryOption.merkleRoot, 'hex'),
          witnessRoot: Buffer.from(entryOption.witnessRoot, 'hex'),
          treeRoot: Buffer.from(entryOption.treeRoot, 'hex'),
          reservedRoot: Buffer.from(entryOption.reservedRoot, 'hex'),
          extraNonce: Buffer.from(entryOption.extraNonce, 'hex'),
          mask: Buffer.from(entryOption.mask, 'hex'),
          chainwork: entryOption.chainwork && BN.from(entryOption.chainwork, 16, 'be'),
        });

        await this.wdb._addTX(tx, entry);

        retries = 0;
      } catch (e) {
        retries++;
        await new Promise(r => setTimeout(r, 10));
        if (retries > 10000) {
          throw e;
        }
        i = Math.max(i - 2, 0);
      } finally {
        await unlock();
      }
    }

    await put(this.store,`latest_block_${this.selectedID}`, {
      hash: entryOption.hash,
      height: entryOption.height,
      time: entryOption.time,
    });
  };

  rescanBlocks = async (startHeight: number, endHeight: number) => {
    for (let i = startHeight; i <= endHeight; i++) {
      if (this.forceStopRescan) {
        this.forceStopRescan = false;
        this.rescanning = false;
        await this.pushState();
        throw new Error('rescan stopped.');
      }
      await this.processBlock(i);
    }
  };

  checkForRescan = async () => {
    if (!this.selectedID || this.rescanning || this.locked) return;

    this.rescanning = true;
    await this.pushState();

    await this.pushBobMessage('Checking status...');
    const latestBlockNow = await this.exec('node', 'getLatestBlock');
    const latestBlockLast = await get(this.store, `latest_block_${this.selectedID}`);

    try {
      if (latestBlockLast && latestBlockLast.height >= latestBlockNow.height) {
        await this.pushBobMessage('I am synchronized.');
      } else if (latestBlockLast && latestBlockNow.height - latestBlockLast.height <= 100) {
        await this.rescanBlocks(latestBlockLast.height + 1, latestBlockNow.height);
      } else {
        await this.fullRescan();
      }

      this.rescanning = false;
      await this.pushState();
      await this.pushBobMessage(`I am synchonized.`);
    } catch (e) {
      console.error(e);
      this.rescanning = false;
      await this.pushState();
      await this.pushBobMessage(`Something went wrong while rescanning.`);
    } finally {
      await pushMessage({
         type: ActionType.SET_TRANSACTIONS,
         payload: await this.getTransactions(),
      });
    }
  };

  async initSocket() {
    const { apiHost, apiKey } = await this.exec('setting', 'getAPI');
    const {hostname} = new URL(apiHost);
    const is5pi = ['5pi.io', 'www.5pi.io'].includes(hostname);
    const socket = bsocket.socket();
    socket.on('connect', async () => {
      try {
        await socket.call(
          'auth',
          is5pi
            ? '775f8ca39e1748a7b47ff16ad4b1b9ad'
            : apiKey,
        );
        await socket.call('watch chain');
      } catch (e) {
        console.error(e);
        return;
      }
    });

    socket.on('error', (err: any) => {
      console.error(err);
    });

    socket.on('disconnect', () => {
      console.log('disconnected');
    });

    socket.bind('block connect', async (data: any) => {
      setTimeout(async () => {
        await this.checkForRescan();
        const {hash, height, time} = await this.exec('node', 'getLatestBlock');
        await pushMessage(setInfo(hash, height, time));
        this.emit('newBlock', {hash, height, time});
      }, 1000);

    });

    socket.connect(apiHost);

    this.socket = socket;
  }

  async start() {
    this.network = Network.get(networkType);
    this.wdb = new WalletDB({
      network: this.network,
      memory: false,
      location: this.network.type === 'main' ? '/walletdb' : `/${this.network}/walletdb`,
      cacheSize: 512 << 20,
      maxFileSize: 256 << 20,
    });

    this.store = bdb.create('/wallet-store');

    this.wdb.on('error', (err: Error) => console.error('wdb error', err));

    await this.wdb.open();
    await this.store.open();

    if (!this.selectedID) {
      const walletIDs = await this.getWalletIDs();
      this.selectedID = walletIDs.filter(id => id !== 'primary')[0];
    }

    this.checkForRescan();
    this.initSocket();
  }

  async stop() {
    if (this.checkStatusTimeout) {
      clearInterval(this.checkStatusTimeout);
    }
  }
}

function mapOneTx(txOptions: any) {
  if (txOptions.witnessHash) {
    txOptions.witnessHash = Buffer.from(txOptions.witnessHash, 'hex');
  }

  txOptions.inputs = txOptions.inputs.map((input: any) => {
    if (input.prevout.hash) {
      input.prevout.hash = Buffer.from(input.prevout.hash, 'hex');
    }

    if (input.coin && input.coin.covenant) {
      input.coin.covenant = new Covenant(
        input.coin.covenant.type,
        input.coin.covenant.items.map((item: any) => Buffer.from(item, 'hex')),
      );
    }

    if (input.witness) {
      input.witness = input.witness.map((wit: any) => Buffer.from(wit, 'hex'));
    }

    return input;
  });

  txOptions.outputs = txOptions.outputs.map((output: any) => {
    if (output.covenant) {
      output.covenant = new Covenant(
        output.covenant.type,
        output.covenant.items.map((item: any) => Buffer.from(item, 'hex')),
      );
    }
    return output;
  });
  const tx = new TX(txOptions);
  return tx;
}
