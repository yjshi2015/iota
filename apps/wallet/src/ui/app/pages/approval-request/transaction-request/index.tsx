// Copyright (c) Mysten Labs, Inc.
// Modifications Copyright (c) 2024 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { ExplorerLinkHelper, UserApproveContainer } from '_components';
import {
    useActiveAddress,
    useAppDispatch,
    useTransactionData,
    useTransactionDryRun,
    useAccountByAddress,
    useSigner,
    useBackgroundClient,
} from '_hooks';
import { type TransactionApprovalRequest } from '_src/shared/messaging/messages/payloads/transactions/approvalRequest';
import { respondToTransactionRequest } from '_redux/slices/transaction-requests';
import { ampli } from '_src/shared/analytics/ampli';
import { PageMainLayoutTitle } from '_src/ui/app/shared/page-main-layout/PageMainLayoutTitle';
import {
    useTransactionSummary,
    TransactionSummary,
    GasFees,
    useRecognizedPackages,
} from '@iota/core';
import { Transaction } from '@iota/iota-sdk/transactions';
import { useMemo, useState } from 'react';
import { ConfirmationModal } from '../../../shared/ConfirmationModal';
import { TransactionDetails } from './transaction-details';
import { Warning, Checkmark } from '@iota/apps-ui-icons';
import { InfoBox, InfoBoxType, InfoBoxStyle } from '@iota/apps-ui-kit';
import { useNavigate } from 'react-router-dom';
import { type SignedTransaction } from '_src/ui/app/walletSigner';
import { AnimatedQRCode } from '@keystonehq/animated-qr';
import { UR } from '@keystonehq/keystone-sdk';
import { useIotaClient } from '@iota/dapp-kit';
import { useAppSelector } from '_hooks';
import { type IotaTransactionBlockResponse } from '@iota/iota-sdk/client';

export interface TransactionRequestProps {
    txRequest: TransactionApprovalRequest;
}

// Some applications require *a lot* of transactions to interact with, and this
// eats up our analytics event quota. As a short-term solution so we don't have
// to stop tracking this event entirely, we'll just manually exclude application
// origins with this list
const APP_ORIGINS_TO_EXCLUDE_FROM_ANALYTICS: string[] = [];

export function TransactionRequest({ txRequest }: TransactionRequestProps) {
    const addressForTransaction = txRequest.tx.account;
    const activeAddress = useActiveAddress();
    const { data: accountForTransaction } = useAccountByAddress(addressForTransaction);
    const signer = useSigner(accountForTransaction);
    const dispatch = useAppDispatch();
    const navigate = useNavigate();
    const client = useIotaClient();
    const backgroundClient = useBackgroundClient();
    const network = useAppSelector(({ app }) => app.network);

    const [isConfirmationVisible, setConfirmationVisible] = useState(false);
    const [showMultisigQR, setShowMultisigQR] = useState(false);
    const [signedTransaction, setSignedTransaction] = useState<SignedTransaction | null>(null);
    const [transactionExecuted, setTransactionExecuted] = useState(false);

    const transaction = useMemo(() => {
        const tx = Transaction.from(txRequest.tx.data);
        if (addressForTransaction) {
            tx.setSenderIfNotSet(addressForTransaction);
        }
        return tx;
    }, [txRequest.tx.data, addressForTransaction]);

    const { isPending, isError } = useTransactionData(addressForTransaction, transaction);

    const isMultisigSigning = accountForTransaction?.type === 'mnemonic-multisig-derived';

    const {
        data,
        isError: isDryRunError,
        isPending: isDryRunLoading,
    } = useTransactionDryRun(addressForTransaction, transaction);
    const recognizedPackagesList = useRecognizedPackages();

    const summary = useTransactionSummary({
        transaction: data,
        currentAddress: addressForTransaction,
        recognizedPackagesList,
    });
    if (!signer) {
        return null;
    }

    // If showing multisig QR code, render only the QR code interface
    if (showMultisigQR && signedTransaction) {
        return (
            <div className="flex flex-col items-center p-6 bg-white min-h-screen">
                <PageMainLayoutTitle title="Scan QR Code to Complete Transaction" />
                <div className="flex flex-col items-center gap-4 mt-4">
                    <div className="p-4 bg-white rounded-lg border">
                        {(() => {
                            try {
                                const qrData = JSON.stringify({
                                    transaction: signedTransaction.bytes,
                                    signature: signedTransaction.signature,
                                    network,
                                });

                                // Use the exact same pattern as multisig-signing page
                                const buffer = Buffer.from(qrData, 'utf8');
                                const ur = UR.from(buffer);

                                return (
                                    <AnimatedQRCode
                                        type={ur.type}
                                        cbor={ur.cbor.toString('hex')}
                                        options={{ size: 256, capacity: 1000 }}
                                    />
                                );
                            } catch (qrError) {
                                return (
                                    <div className="w-64 h-64 flex items-center justify-center border">
                                        <p className="text-sm text-gray-500">QR Code generation failed</p>
                                    </div>
                                );
                            }
                        })()}
                    </div>
                    <div className="text-center">
                        <p className="text-sm text-gray-600 mb-2">
                            Scan this QR code with your Keystone device to complete the multisig transaction
                        </p>
                        {transactionExecuted && (
                            <div className="flex items-center gap-2 text-green-600">
                                <Checkmark />
                                <span>Transaction executed successfully!</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // Default approval interface
    return (
        <>
            <UserApproveContainer
                origin={txRequest.origin}
                originFavIcon={txRequest.originFavIcon}
                approveTitle="Approve"
                rejectTitle="Reject"
                onSubmit={async (approved: boolean) => {
                    if (isPending) return;
                    if (approved && isError) {
                        setConfirmationVisible(true);
                        return;
                    }

                    // For multisig transactions, handle the complete flow inline
                    if (approved && isMultisigSigning) {
                        try {
                            const result = await dispatch(
                                respondToTransactionRequest({
                                    approved,
                                    txRequestID: txRequest.id,
                                    signer,
                                    isMultisigSigning,
                                }),
                            );

                            if (result.payload && typeof result.payload === 'object' && 'signedTransaction' in result.payload && result.payload.signedTransaction) {
                                const signedTx = result.payload.signedTransaction as SignedTransaction;
                                setSignedTransaction(signedTx);
                                setShowMultisigQR(true);

                                // Start monitoring for transaction execution
                                try {
                                    const tx = Transaction.from(txRequest.tx.data);
                                    if (addressForTransaction) {
                                        tx.setSenderIfNotSet(addressForTransaction);
                                    }

                                    // Build the transaction first to ensure it has all necessary data
                                    await tx.build({ client });
                                    const digest = await tx.getDigest();

                                    client
                                        .waitForTransaction({
                                            digest,
                                            timeout: 10 * 60 * 1000, // 10 min
                                        })
                                        .then(async (response) => {
                                            setTransactionExecuted(true);

                                            // Get the full transaction details
                                            const fullTransaction = await client.getTransactionBlock({
                                                digest: response.digest,
                                                options: txRequest.tx.options,
                                            });

                                            // Send the final response to the dApp
                                            await backgroundClient.sendTransactionRequestResponse(
                                                txRequest.id,
                                                true, // approved
                                                fullTransaction,
                                                undefined, // no error
                                                undefined // no signed transaction since it's executed
                                            );

                                            const receiptUrl = `/receipt?txdigest=${encodeURIComponent(response.digest)}&from=transactions`;
                                            navigate(receiptUrl);
                                        })
                                        .catch((error) => {
                                            // Send error response
                                            backgroundClient.sendTransactionRequestResponse(
                                                txRequest.id,
                                                false, // failed
                                                undefined,
                                                `Transaction execution failed: ${error.message}`,
                                                undefined
                                            );
                                        });
                                } catch (digestError) {
                                    // Still show QR but without monitoring - user can complete manually
                                }
                            }
                        } catch (error) {
                            // Send error response to prevent hanging
                            await backgroundClient.sendTransactionRequestResponse(
                                txRequest.id,
                                false, // failed
                                undefined,
                                `Multisig flow failed: ${error instanceof Error ? error.message : String(error)}`,
                                undefined
                            );
                        }
                        return;
                    }

                    // For regular transactions, use the normal flow
                    await dispatch(
                        respondToTransactionRequest({
                            approved,
                            txRequestID: txRequest.id,
                            signer,
                            isMultisigSigning,
                        }),
                    );
                    if (!APP_ORIGINS_TO_EXCLUDE_FROM_ANALYTICS.includes(txRequest.origin)) {
                        ampli.respondedToTransactionRequest({
                            applicationUrl: txRequest.origin,
                            approvedTransaction: approved,
                            receivedFailureWarning: false,
                        });
                    }
                }}
                address={addressForTransaction}
                approveLoading={isPending || isConfirmationVisible}
                checkAccountLock
            >
                <PageMainLayoutTitle title="Approve Transaction" />
                <div className="-mr-3 flex flex-col gap-md">
                    <TransactionSummary
                        isDryRun
                        isLoading={isDryRunLoading}
                        isError={isDryRunError}
                        summary={summary}
                        renderExplorerLink={ExplorerLinkHelper}
                    />
                    {(!summary || isDryRunError) && (
                        <InfoBox
                            title="Review the transaction"
                            supportingText="Unexpected issue during the dry run. The transaction may not execute properly."
                            icon={<Warning />}
                            type={InfoBoxType.Default}
                            style={InfoBoxStyle.Elevated}
                        />
                    )}
                    <GasFees
                        sender={addressForTransaction}
                        gasSummary={summary?.gas}
                        isEstimate
                        isError={isError}
                        isPending={isDryRunLoading}
                        activeAddress={activeAddress}
                        renderExplorerLink={ExplorerLinkHelper}
                    />
                    <TransactionDetails sender={addressForTransaction} transaction={transaction} />
                </div>
            </UserApproveContainer>
            <ConfirmationModal
                isOpen={isConfirmationVisible}
                title="Are you sure you want to approve the transaction?"
                hint="This transaction might fail. You will still be charged a gas fee for this transaction."
                confirmText="Approve"
                cancelText="Reject"
                onResponse={async (isConfirmed) => {
                    if (!signer) {
                        throw new Error('Signer not available');
                    }

                    const result = await dispatch(
                        respondToTransactionRequest({
                            approved: isConfirmed,
                            txRequestID: txRequest.id,
                            signer,
                            isMultisigSigning,
                        }),
                    );

                    // Handle navigation for multisig vs regular transactions
                    if (isConfirmed && result.payload && typeof result.payload === 'object' && 'signedTransaction' in result.payload && result.payload.signedTransaction && isMultisigSigning) {
                        const signedTx = result.payload.signedTransaction as SignedTransaction;
                        const multisigSigningUrl = `/multisig-signing?txbytes=${encodeURIComponent(
                            signedTx.bytes,
                        )}&signature=${encodeURIComponent(
                            signedTx.signature,
                        )}&from=transactions&txRequestID=${encodeURIComponent(txRequest.id)}`;
                        navigate(multisigSigningUrl);
                        // Don't close the confirmation modal for multisig - let the navigation handle it
                        return;
                    }
                    ampli.respondedToTransactionRequest({
                        applicationUrl: txRequest.origin,
                        approvedTransaction: isConfirmed,
                        receivedFailureWarning: true,
                    });
                    setConfirmationVisible(false);
                }}
            />
        </>
    );
}
