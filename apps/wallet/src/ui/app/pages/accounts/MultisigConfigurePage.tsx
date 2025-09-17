// Copyright (c) 2025 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { PageTemplate } from '_components';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { MultisigConfigureForm } from '../../components/multisig/MultisigConfigureForm';
import { useAccounts, useBackgroundClient } from '../../hooks';
import { AccountType } from '_src/background/accounts/account';

export function MultisigConfigurePage() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const ourPubKey = searchParams.get('ourPubKey');
    const sourceID = searchParams.get('sourceID');
    const accountID = searchParams.get('accountID');
    const isNew = searchParams.get('isNew') === 'true';

    const { data: allAccounts, isPending } = useAccounts();
    const account = allAccounts?.find(({ id }) => accountID === id) || null;
    const backgroundClient = useBackgroundClient();

    if (
        !isPending &&
        (!ourPubKey ||
            !sourceID ||
            !accountID ||
            !account ||
            account?.type !== AccountType.MnemonicMultisigDerived)
    ) {
        return <Navigate to="/" replace />;
    }

    async function handleOnSubmit({
        threshold,
        pubKeys,
    }: {
        threshold: number;
        pubKeys: { pubKey: string; weight: number }[];
    }) {
        await backgroundClient.finalizeMultisigAccount({
            accountID: accountID!,
            ourPubKey: ourPubKey!,
            multisigConfig: {
                threshold,
                pubKeys,
            },
        });

        if (isNew) {
            navigate(`/accounts/backup/${sourceID}`, {
                replace: true,
                state: {
                    onboarding: true,
                },
            });
        } else {
            navigate('/');
        }
    }

    return (
        <PageTemplate title="Configure your MultiSig" isTitleCentered showBackButton>
            <div className="flex h-full w-full flex-col items-center ">
                <div className="w-full grow">
                    <MultisigConfigureForm onSubmit={handleOnSubmit} ourPubKey={ourPubKey!} />
                </div>
            </div>
        </PageTemplate>
    );
}
