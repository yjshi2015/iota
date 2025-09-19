// Copyright (c) Mysten Labs, Inc.
// Modifications Copyright (c) 2024 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import {
    isSignPersonalMessageApprovalRequest,
    isTransactionApprovalRequest,
} from '_src/shared/messaging/messages/payloads/transactions/approvalRequest';
import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Loading } from '_components';
import { useAppSelector, useActiveAccount } from '_hooks';
import { type RootState } from '../../redux/rootReducer';
import { txRequestsSelectors } from '../../redux/slices/transaction-requests';
import { SignMessageRequest } from './SignMessageRequest';
import { TransactionRequest } from './transaction-request';

export function ApprovalRequestPage() {
    const { requestID } = useParams();
    const activeAccount = useActiveAccount();
    const requestSelector = useMemo(
        () => (state: RootState) =>
            (requestID && txRequestsSelectors.selectById(state, requestID)) || null,
        [requestID],
    );
    const request = useAppSelector(requestSelector);
    const requestsLoading = useAppSelector(
        ({ transactionRequests }) => !transactionRequests.initialized,
    );

    // Check if this is a multisig account
    const isMultisigSigning = activeAccount?.type === 'mnemonic-multisig-derived';

    useEffect(() => {
        // For multisig transactions that are approved, don't close the window - the navigation will handle the flow
        // For regular transactions or rejected transactions, close as normal
        // For multisig transactions that are approved, keep window open until transaction is executed
        const shouldCloseWindow =
            !requestsLoading &&
            (!request ||
                (request &&
                    request.approved !== null &&
                    !(
                        isMultisigSigning &&
                        request?.approved === true &&
                        isTransactionApprovalRequest(request)
                    )));

        if (shouldCloseWindow) {
            window.close();
        }
    }, [requestsLoading, request, isMultisigSigning]);
    return (
        <Loading loading={requestsLoading}>
            {request ? (
                isSignPersonalMessageApprovalRequest(request) ? (
                    <SignMessageRequest request={request} />
                ) : isTransactionApprovalRequest(request) ? (
                    <TransactionRequest txRequest={request} />
                ) : null
            ) : null}
        </Loading>
    );
}
