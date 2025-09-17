// Copyright (c) 2025 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { type Keypair } from '@iota/iota-sdk/cryptography';
import {
    type SerializedAccount,
    type SerializedUIAccount,
    Account,
    AccountType,
    type KeyPairExportableAccount,
    type PasswordUnlockableAccount,
    type SigningAccount,
} from './account';
import { fromExportedKeypair } from '_src/shared/utils';
import { MnemonicAccountSource } from '../account-sources/mnemonicAccountSource';
import { accountsEvents } from './events';
import { getDB } from '../db';
import { MultiSigPublicKey } from '@iota/iota-sdk/multisig/publickey';
import { publicKeyFromIotaBytes } from '@iota/iota-sdk/verify';

export interface PubKeyWeightPair {
    pubKey: string;
    weight: number;
}

export interface MultisigConfig {
    threshold: number;
    pubKeys: PubKeyWeightPair[];
}

export interface MnemonicMultisigSerializedAccount extends SerializedAccount {
    type: AccountType.MnemonicMultisigDerived;
    sourceID: string;
    derivationPath: string;
    publicKey: string;
    multisigConfig: MultisigConfig | null;
    multisigPublicKey: string | null;
}

export interface MnemonicMultisigSerializedUiAccount extends SerializedUIAccount {
    type: AccountType.MnemonicMultisigDerived;
    publicKey: string;
    derivationPath: string;
    sourceID: string;
}

export function isMnemonicMultisigSerializedUiAccount(
    account: SerializedUIAccount,
): account is MnemonicMultisigSerializedUiAccount {
    return account.type === AccountType.MnemonicMultisigDerived;
}

type SessionStorageData = { keyPair: string };

export class MnemonicMultisigAccount
    extends Account<MnemonicMultisigSerializedAccount, SessionStorageData>
    implements PasswordUnlockableAccount, SigningAccount, KeyPairExportableAccount
{
    readonly unlockType = 'password' as const;
    readonly canSign = true;
    readonly exportableKeyPair = true;

    static isOfType(
        serialized: SerializedAccount,
    ): serialized is MnemonicMultisigSerializedAccount {
        return serialized.type === AccountType.MnemonicMultisigDerived;
    }

    static createNew({
        keyPair,
        derivationPath,
        sourceID,
    }: {
        keyPair: Keypair;
        derivationPath: string;
        sourceID: string;
    }): Omit<MnemonicMultisigSerializedAccount, 'id'> {
        return {
            type: AccountType.MnemonicMultisigDerived,
            sourceID,
            address: keyPair.getPublicKey().toIotaAddress(),
            derivationPath,
            publicKey: keyPair.getPublicKey().toBase64(),
            lastUnlockedOn: null,
            selected: false,
            nickname: null,
            createdAt: Date.now(),
            multisigConfig: null,
            multisigPublicKey: null,
        };
    }

    constructor({
        id,
        cachedData,
    }: {
        id: string;
        cachedData?: MnemonicMultisigSerializedAccount;
    }) {
        super({ type: AccountType.MnemonicMultisigDerived, id, cachedData });
    }

    async isLocked(): Promise<boolean> {
        return !(await this.#getKeyPair());
    }

    async lock(allowRead = false): Promise<void> {
        await this.clearEphemeralValue();
        await this.onLocked(allowRead);
    }

    async passwordUnlock(password?: string): Promise<void> {
        const mnemonicSource = await this.#getMnemonicSource();
        if ((await mnemonicSource.isLocked()) && !password) {
            throw new Error('Missing password to unlock the account');
        }
        const { derivationPath } = await this.getStoredData();
        if (password) {
            await mnemonicSource.unlock(password);
        }
        await this.setEphemeralValue({
            keyPair: (await mnemonicSource.deriveKeyPair(derivationPath)).getSecretKey(),
        });
        await this.onUnlocked();
    }

    async verifyPassword(password: string): Promise<void> {
        const mnemonicSource = await this.#getMnemonicSource();
        await mnemonicSource.verifyPassword(password);
    }

    async toUISerialized(): Promise<MnemonicMultisigSerializedUiAccount> {
        const { id, type, address, derivationPath, publicKey, sourceID, selected, nickname } =
            await this.getStoredData();
        return {
            id,
            type,
            address,
            isLocked: await this.isLocked(),
            derivationPath,
            publicKey,
            sourceID,
            lastUnlockedOn: await this.lastUnlockedOn,
            selected,
            nickname,
            isPasswordUnlockable: true,
            isKeyPairExportable: true,
        };
    }

    async signData(data: Uint8Array): Promise<string> {
        const keyPair = await this.#getKeyPair();
        if (!keyPair) {
            throw new Error(`Account is locked`);
        }
        return this.generateSignature(data, keyPair);
    }

    get derivationPath() {
        return this.getCachedData().then(({ derivationPath }) => derivationPath);
    }

    get sourceID() {
        return this.getCachedData().then(({ sourceID }) => sourceID);
    }

    get multisigConfig() {
        return this.getCachedData().then(({ multisigConfig }) => multisigConfig);
    }

    async exportKeyPair(password: string): Promise<string> {
        const { derivationPath } = await this.getStoredData();
        const mnemonicSource = await this.#getMnemonicSource();
        await mnemonicSource.unlock(password);
        return (await mnemonicSource.deriveKeyPair(derivationPath)).getSecretKey();
    }

    async #getKeyPair() {
        const ephemeralData = await this.getEphemeralValue();
        if (ephemeralData) {
            return fromExportedKeypair(ephemeralData.keyPair);
        }
        return null;
    }

    async #getMnemonicSource() {
        return new MnemonicAccountSource((await this.getStoredData()).sourceID);
    }

    public async setMultisigConfig(multisigConfig: MultisigConfig) {
        await (await getDB()).accounts.update(this.id, { multisigConfig });
        accountsEvents.emit('accountStatusChanged', { accountID: this.id });
    }

    public async buildMultisig() {
        const { multisigConfig } = await this.getStoredData();

        if (!multisigConfig) {
            throw new Error('Multisig config not set');
        }

        const multisigPublicKey = MultiSigPublicKey.fromPublicKeys({
            threshold: multisigConfig.threshold,
            publicKeys: multisigConfig.pubKeys.map((pubKeyWeightPair) => ({
                publicKey: publicKeyFromIotaBytes(pubKeyWeightPair.pubKey),
                weight: pubKeyWeightPair.weight,
            })),
        });

        const multisigAddress = multisigPublicKey.toIotaAddress();

        await (
            await getDB()
        ).accounts.update(this.id, { multisigPublicKey, address: multisigAddress });

        accountsEvents.emit('accountStatusChanged', { accountID: this.id });
    }
}
