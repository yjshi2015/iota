// Copyright (c) 2025 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { Loading, Overlay } from '_components';
import { useActiveAddress, useAppSelector, useUnlockedGuard, useBackgroundClient } from '_hooks';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Checkmark } from '@iota/apps-ui-icons';
import { AnimatedQRCode } from '@keystonehq/animated-qr';
import { UR } from '@keystonehq/keystone-sdk';
import { Transaction } from '@iota/iota-sdk/transactions';
import { useIotaClient } from '@iota/dapp-kit';

export function MultisigSigningPage() {
    const network = useAppSelector(({ app }) => app.network);
    const client = useIotaClient();
    const backgroundClient = useBackgroundClient();
    const [searchParams] = useSearchParams();
    const [showModal, setShowModal] = useState(true);
    const activeAddress = useActiveAddress();

    const transaction = searchParams.get('txbytes');
    const signature = searchParams.get('signature');
    const txRequestID = searchParams.get('txRequestID'); // New parameter for dApp transactions

    const buffer = Buffer.from(JSON.stringify({ transaction, signature, network }), 'utf8');
    const ur = UR.from(buffer);

    const fromParam = searchParams.get('from');

    const navigate = useNavigate();

    const onClose = useCallback(() => {
        // If this is from a dApp transaction request and the user closes without completing,
        // send a rejection response
        if (txRequestID) {
            backgroundClient.sendTransactionRequestResponse(
                txRequestID,
                false, // rejected
                undefined,
                'User closed the signing interface',
                undefined,
            );
        }
        fromParam ? navigate(`/${fromParam}`) : navigate(-1);
    }, [fromParam, navigate, txRequestID, backgroundClient]);

    const isGuardLoading = useUnlockedGuard();

    if (!transaction || !signature || !network || !activeAddress) {
        return <Navigate to="/transactions" replace={true} />;
    }

    const tx = Transaction.from(transaction);

    useEffect(() => {
        const abortController = new AbortController();
        let transactionCompleted = false;
        (async () => {
            const digest = await tx.getDigest();
            client
                .waitForTransaction({
                    signal: abortController.signal,
                    digest,
                    timeout: 10 * 60 * 1000, // 10 min
                })
                .then(async (response) => {
                    transactionCompleted = true;
                    const receiptUrl = `/receipt?txdigest=${encodeURIComponent(
                        response.digest,
                    )}&from=transactions`;
                    return navigate(receiptUrl);
                })
                .catch((error) => {
                    transactionCompleted = true;
                    // If there's an error and this is from a dApp, send error response
                    if (txRequestID) {
                        backgroundClient.sendTransactionRequestResponse(
                            txRequestID,
                            false, // not approved (due to error)
                            undefined,
                            error.message || 'Transaction failed',
                            undefined,
                        );
                    }
                    console.error('Transaction failed:', error);
                });
        })();

        // Cleanup: if component unmounts and transaction hasn't completed, send rejection
        return () => {
            abortController.abort();
            if (txRequestID && !transactionCompleted) {
                backgroundClient.sendTransactionRequestResponse(
                    txRequestID,
                    false, // rejected
                    undefined,
                    'User aborted the signing process',
                    undefined,
                );
            }
        };
    }, [tx, txRequestID, backgroundClient, navigate, client]);

    return (
        <Loading loading={isGuardLoading}>
            <Overlay
                showModal={showModal}
                setShowModal={setShowModal}
                title={'Transaction Data'}
                closeOverlay={onClose}
                closeIcon={<Checkmark fill="currentColor" className="text-iota-light h-8 w-8" />}
            >
                <div className="flex h-full flex-col items-center justify-center gap-xs">
                    <AnimatedQRCode
                        type={ur.type}
                        cbor={ur.cbor.toString('hex')}
                        options={{ size: 280, capacity: 1000 }}
                    />
                    <span className="text-title-sm text-iota-neutral-10 dark:text-iota-neutral-92">
                        Scan this QR code with the IOTA Aegis app
                    </span>
                </div>
            </Overlay>
        </Loading>
    );
}
