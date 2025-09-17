// Copyright (c) 2025 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { Loading, Overlay } from '_components';
import { useActiveAddress, useAppSelector, useUnlockedGuard } from '_hooks';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Checkmark } from '@iota/apps-ui-icons';
import { AnimatedQRCode } from '@keystonehq/animated-qr';
import { UR } from '@keystonehq/keystone-sdk';
import { Transaction } from '@iota/iota-sdk/transactions';
import { useIotaClient } from '@iota/dapp-kit';
import { type IotaTransactionBlockResponse } from '@iota/iota-sdk/client';

export function MultisigSigningPage() {
    const network = useAppSelector(({ app }) => app.network);
    const client = useIotaClient();
    const [searchParams] = useSearchParams();
    const [showModal, setShowModal] = useState(true);
    const activeAddress = useActiveAddress();

    const transaction = searchParams.get('txbytes');
    const signature = searchParams.get('signature');

    const buffer = Buffer.from(JSON.stringify({ transaction, signature, network }), 'utf8');
    const ur = UR.from(buffer);

    const fromParam = searchParams.get('from');

    const navigate = useNavigate();

    const onClose = useCallback(() => {
        fromParam ? navigate(`/${fromParam}`) : navigate(-1);
    }, [fromParam, navigate]);

    const isGuardLoading = useUnlockedGuard();

    if (!transaction || !signature || !network || !activeAddress) {
        return <Navigate to="/transactions" replace={true} />;
    }

    const tx = Transaction.from(transaction);

    useEffect(() => {
        const abortController = new AbortController();
        (async () => {
            const digest = await tx.getDigest();
            client
                .waitForTransaction({
                    signal: abortController.signal,
                    digest,
                    timeout: 10 * 60 * 1000, // 10 min
                })
                .then((response) => {
                    const receiptUrl = `/receipt?txdigest=${encodeURIComponent(
                        (response as IotaTransactionBlockResponse).digest,
                    )}&from=transactions`;
                    return navigate(receiptUrl);
                });
        })();

        return () => abortController.abort();
    }, [tx]);

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
