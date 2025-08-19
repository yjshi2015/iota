// Copyright (c) 2024 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

use std::{str::FromStr, time::Duration};

use futures::future::join_all;
use iota_cluster_test::faucet::{FaucetClient, RemoteFaucetClient};
use iota_indexer::{errors::IndexerError, types::IndexerResult};
use iota_json::{call_args, type_args};
use iota_json_rpc_api::{
    CoinReadApiClient, IndexerApiClient, ReadApiClient, TransactionBuilderClient, WriteApiClient,
};
use iota_json_rpc_types::{
    EventFilter, IotaTransactionBlockDataAPI, IotaTransactionBlockEffectsAPI,
    IotaTransactionBlockResponseOptions, IotaTransactionBlockResponseQuery, IotaTransactionKind,
    TransactionFilter,
};
use iota_types::{
    self,
    base_types::{IotaAddress, ObjectID},
    crypto::{AccountKeyPair, get_key_pair},
    quorum_driver_types::ExecuteTransactionRequestType,
    utils::to_sender_signed_transaction,
};
use itertools::Itertools;
use jsonrpsee::http_client::HttpClient;

use crate::{
    common::connect_to_rpcs_and_faucet,
    write_api::{
        create_basic_object, create_basic_object_with_gas, create_counter_object,
        deploy_basics_pkg, increment_counter,
    },
};

const EXPERIMENTS_CNT: u64 = 20;

/// Split a single coin into many smaller coins for parallel testing
async fn split_coin_into_many(
    client: &HttpClient,
    sender: IotaAddress,
    sender_kp: &AccountKeyPair,
    coin_to_split: ObjectID,
    num_coins: usize,
    amount_per_coin: u64,
    gas_budget: u64,
) -> Result<Vec<ObjectID>, anyhow::Error> {
    // Calculate how many coins we can create with the available balance
    let amounts: Vec<u64> = (0..num_coins).map(|_| amount_per_coin).collect();

    let transaction_bytes = client
        .split_coin(
            sender,
            coin_to_split,
            amounts.iter().map(|&amount| amount.into()).collect(),
            None, // Use coin_to_split as gas
            gas_budget.into(),
        )
        .await?;

    let tx = to_sender_signed_transaction(transaction_bytes.to_data()?, sender_kp);
    let (tx_bytes, signatures) = tx.to_tx_bytes_and_signatures();

    let tx_response = client
        .execute_transaction_block(
            tx_bytes,
            signatures,
            Some(IotaTransactionBlockResponseOptions::full_content()),
            Some(ExecuteTransactionRequestType::WaitForLocalExecution),
        )
        .await?;
    assert_eq!(tx_response.status_ok(), Some(true));

    // Extract the newly created coin IDs
    let new_coin_ids: Vec<ObjectID> = tx_response
        .effects
        .unwrap()
        .created()
        .iter()
        .map(|created_obj| created_obj.object_id())
        .collect();

    println!(
        "Successfully split coin into {} new coins",
        new_coin_ids.len()
    );
    Ok(new_coin_ids)
}

#[tokio::test]
async fn test_transfer_object_indexer() {
    let (_node_client, indexer_client, _indexer_client_wo_optimistic, faucet) =
        connect_to_rpcs_and_faucet().await;

    test_transfer_iota_for_given_client(&indexer_client, &faucet, 20).await;
}

#[tokio::test]
async fn test_numerous_increments_counter_private_indexer() {
    let (_node_client, indexer_client, _indexer_client_wo_optimistic, faucet) =
        connect_to_rpcs_and_faucet().await;

    test_increment_counter_for_given_client(&indexer_client, &faucet, 20).await;
}

#[tokio::test]
async fn test_generate_n_events_indexer() {
    let (_node_client, indexer_client, _indexer_client_wo_optimistic, faucet) =
        connect_to_rpcs_and_faucet().await;

    create_events_for_given_client(&indexer_client, &faucet, 20)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_measure_optimistic_indexer_pagination() {
    let (_node_client, indexer_client, _indexer_client_wo_optimistic, _faucet) =
        connect_to_rpcs_and_faucet().await;
    let filter = TransactionFilter::TransactionKind(IotaTransactionKind::ProgrammableTransaction);

    println!("Requesting 1000 transactions from the optimistic indexer");
    measure_paginated_filtered_transactions_for_filter(&indexer_client, 5, 1000, filter)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_measure_nonoptimistic_indexer_pagination() {
    let (_node_client, _indexer_client, indexer_client_wo_optimistic, _faucet) =
        connect_to_rpcs_and_faucet().await;
    let filter = TransactionFilter::TransactionKind(IotaTransactionKind::ProgrammableTransaction);

    println!("Requesting 1000 transactions from the NON-optimistic indexer");
    measure_paginated_filtered_transactions_for_filter(
        &indexer_client_wo_optimistic,
        5,
        1000,
        filter,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn test_measure_optimistic_indexer_pagination_by_address() {
    let (_node_client, indexer_client, _indexer_client_wo_optimistic, _faucet) =
        connect_to_rpcs_and_faucet().await;
    let address = get_some_real_address_from_network(&indexer_client)
        .await
        .unwrap();

    println!("Requesting 1000 transactions from the optimistic indexer");
    measure_paginated_filtered_transactions_for_filter(
        &indexer_client,
        5,
        1000,
        TransactionFilter::FromAddress(address),
    )
    .await
    .unwrap();
    measure_paginated_filtered_transactions_for_filter(
        &indexer_client,
        5,
        1000,
        TransactionFilter::ToAddress(address),
    )
    .await
    .unwrap();
    measure_paginated_filtered_transactions_for_filter(
        &indexer_client,
        5,
        1000,
        TransactionFilter::FromOrToAddress { addr: address },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn test_measure_nonoptimistic_indexer_pagination_by_address() {
    let (_node_client, _indexer_client, indexer_client_wo_optimistic, _faucet) =
        connect_to_rpcs_and_faucet().await;
    let address = get_some_real_address_from_network(&indexer_client_wo_optimistic)
        .await
        .unwrap();

    println!("Requesting 1000 transactions from the NON-optimistic indexer");
    measure_paginated_filtered_transactions_for_filter(
        &indexer_client_wo_optimistic,
        5,
        1000,
        TransactionFilter::FromAddress(address),
    )
    .await
    .unwrap();
    measure_paginated_filtered_transactions_for_filter(
        &indexer_client_wo_optimistic,
        5,
        1000,
        TransactionFilter::ToAddress(address),
    )
    .await
    .unwrap();
    measure_paginated_filtered_transactions_for_filter(
        &indexer_client_wo_optimistic,
        5,
        1000,
        TransactionFilter::FromOrToAddress { addr: address },
    )
    .await
    .unwrap();
}

#[expect(dead_code)]
async fn get_gas_object_id(client: &HttpClient, address: IotaAddress) -> ObjectID {
    client
        .get_coins(address, None, None, None)
        .await
        .unwrap()
        .data[0]
        .coin_object_id
}

pub async fn indexer_wait_for_coins(
    indexer_client: &HttpClient,
    owner: &IotaAddress,
    coins_cnt: u32,
) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let mut total_coins = 0;
            let mut cursor = None;

            // Traverse all pages to count total coins
            loop {
                match indexer_client.get_coins(*owner, None, cursor, None).await {
                    Ok(coins_page) => {
                        total_coins += coins_page.data.len();
                        println!("DEBUG: Current total coins: {total_coins}");

                        // Check if we have enough coins
                        if total_coins >= coins_cnt as usize {
                            return; // Exit the timeout block - we have enough coins
                        }

                        // Move to next page if available
                        if coins_page.has_next_page {
                            cursor = coins_page.next_cursor;
                        } else {
                            println!("No more pages, exiting pagination loop, cnt: {total_coins}");
                            break; // No more pages, exit pagination loop
                        }
                    }
                    Err(e) => {
                        // API call failed, break and try again after sleep
                        println!("API call failed: {e:?}");
                        break;
                    }
                }
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Timeout waiting for coins");
}

async fn test_transfer_iota_for_given_client(
    client: &HttpClient,
    faucet: &RemoteFaucetClient,
    transfer_n_times: u64,
) {
    let (sender, keypair_sender): (_, AccountKeyPair) = get_key_pair();
    let (receiver, _keypair_receiver): (_, AccountKeyPair) = get_key_pair();

    let faucet_res = faucet.request_iota_coins(sender).await;
    indexer_wait_for_coins(client, &sender, 1).await;
    println!("FAUCET: {faucet_res:?}");

    let object_to_send = faucet_res.transferred_gas_objects[0].id;

    let start = std::time::Instant::now();

    for i in 0..(EXPERIMENTS_CNT * transfer_n_times) {
        let current_sender = sender;
        let current_receiver = receiver;
        let current_sender_kp = &keypair_sender;

        let tx_bytes = client
            .transfer_iota(
                current_sender,
                object_to_send,
                100_000_000.into(),
                current_receiver,
                Some(1_000_000.into()),
            )
            .await
            .unwrap();
        let txn = to_sender_signed_transaction(tx_bytes.to_data().unwrap(), current_sender_kp);
        let (tx_bytes, signatures) = txn.to_tx_bytes_and_signatures();
        let _res = client
            .execute_transaction_block(
                tx_bytes,
                signatures,
                Some(IotaTransactionBlockResponseOptions::full_content()),
                Some(ExecuteTransactionRequestType::WaitForLocalExecution),
            )
            .await
            .unwrap();

        let new_balance = client.get_balance(current_receiver, None).await.unwrap();
        assert_eq!(new_balance.total_balance, 1_000_000u128 * (i as u128 + 1));
    }

    let duration = start.elapsed();
    let avg = duration.as_secs_f64() / (EXPERIMENTS_CNT as f64);
    println!(
        "Total time for {} iterations: {:.3} seconds, average per iteration: {:.6} seconds",
        EXPERIMENTS_CNT,
        duration.as_secs_f64(),
        avg
    );
}

async fn test_increment_counter_for_given_client(
    client: &HttpClient,
    faucet: &RemoteFaucetClient,
    increment_n_times: u64,
) {
    let (sender, keypair_sender): (_, AccountKeyPair) = get_key_pair();
    faucet.request_iota_coins(sender).await;
    indexer_wait_for_coins(client, &sender, 1).await;

    let (_, package_id) = deploy_basics_pkg(sender, &keypair_sender, client).await;
    println!("Publish result: {package_id:#?}");

    let start = std::time::Instant::now();
    for _ in 0..EXPERIMENTS_CNT {
        let current_sender = sender;
        let current_sender_kp = &keypair_sender;

        let (_, counter_obj) =
            create_counter_object(current_sender, current_sender_kp, client, &package_id)
                .await
                .unwrap();

        for _ in 0..increment_n_times {
            let res = increment_counter(
                current_sender,
                current_sender_kp,
                client,
                &package_id,
                &counter_obj,
                None,
            )
            .await
            .unwrap();
            assert_eq!(res.status_ok(), Some(true));
        }
    }

    let duration = start.elapsed();
    let avg = duration.as_secs_f64() / (EXPERIMENTS_CNT as f64);
    println!(
        "Total time for {} iterations: {:.3} seconds, average per iteration: {:.6} seconds",
        EXPERIMENTS_CNT,
        duration.as_secs_f64(),
        avg
    );
}

async fn create_events_for_given_client(
    client: &HttpClient,
    faucet: &RemoteFaucetClient,
    generate_event_n_times: u64,
) -> IndexerResult<()> {
    let (sender, sender_kp): (_, AccountKeyPair) = get_key_pair();
    faucet.request_iota_coins(sender).await;
    indexer_wait_for_coins(client, &sender, 1).await;

    let start = std::time::Instant::now();
    for _i in 0..EXPERIMENTS_CNT {
        let (_, package_id) = deploy_basics_pkg(sender, &sender_kp, client).await;
        let basic_obj_1 = create_basic_object(sender, &sender_kp, client, &package_id).await?;
        let basic_obj_2 = create_basic_object(sender, &sender_kp, client, &package_id).await?;

        for _ in 0..generate_event_n_times {
            // Update the object to generate new event
            let res = crate::coin_api::execute_move_call(
                client,
                sender,
                &sender_kp,
                package_id,
                "object_basics".to_string(),
                "update".to_string(),
                type_args![].unwrap(),
                call_args!(basic_obj_1, basic_obj_2).unwrap(),
                None,
            )
            .await
            .unwrap();
            assert_eq!(res.status_ok(), Some(true));

            let _event_id = res
                .events
                .as_ref()
                .unwrap()
                .data
                .iter()
                .exactly_one()
                .unwrap()
                .id;

            // despite the naming, there is no 100% guarantee that the result here comes
            // from optimistic indexing, but it's very likely
            let result_optimistic = client.get_events(res.digest).await.unwrap();
            assert_eq!(result_optimistic.len(), 1);
        }
    }

    let duration = start.elapsed();
    let avg = duration.as_secs_f64() / (EXPERIMENTS_CNT as f64);
    println!(
        "Total time for {} iterations: {:.3} seconds, average per iteration: {:.6} seconds",
        EXPERIMENTS_CNT,
        duration.as_secs_f64(),
        avg
    );

    Ok(())
}

async fn measure_paginated_filtered_transactions_for_filter(
    client: &HttpClient,
    page_size: usize,
    transactions_to_fetch: usize,
    transaction_filter: TransactionFilter,
) -> Result<(), IndexerError> {
    let start_time = std::time::Instant::now();
    let mut cursor = None;
    let mut transactions_processed = 0;
    let mut request_count = 0;
    let mut total_transactions_received = 0;
    let mut query_times = Vec::new();

    println!(
        "Starting paginated transaction query with page_size={page_size}, target_transactions={transactions_to_fetch} and filter={transaction_filter:?}"
    );

    let query = IotaTransactionBlockResponseQuery::new_with_filter(transaction_filter);
    loop {
        request_count += 1;
        let query_start = std::time::Instant::now();

        let page = client
            .query_transaction_blocks(query.clone(), cursor, Some(page_size), None)
            .await
            .unwrap();

        let query_duration = query_start.elapsed();
        query_times.push(query_duration);

        let actual_page_size = page.data.len();
        total_transactions_received += actual_page_size;

        // println!(
        //     "Request {}: received {} transactions in {:.3}ms",
        //     request_count,
        //     actual_page_size,
        //     query_duration.as_millis()
        // );

        let transactions_remaining = transactions_to_fetch - transactions_processed;
        let expected_page_size = std::cmp::min(page_size, transactions_remaining);
        let is_last_page = transactions_processed + expected_page_size >= transactions_to_fetch;

        if is_last_page {
            break;
        }
        cursor = page.next_cursor;
        transactions_processed += expected_page_size;
    }

    let total_duration = start_time.elapsed();
    let avg_query_time = query_times.iter().sum::<std::time::Duration>() / query_times.len() as u32;
    let min_query_time = query_times.iter().min().unwrap();
    let max_query_time = query_times.iter().max().unwrap();

    println!("\n=== Pagination Performance Summary ===");
    println!("Total requests made: {request_count}");
    println!("Total transactions received: {total_transactions_received}");
    println!("Target transactions to fetch: {transactions_to_fetch}");
    println!("Total time: {:.3} seconds", total_duration.as_secs_f64());
    println!("Average query time: {:.3}ms", avg_query_time.as_millis());
    println!("Minimum query time: {:.3}ms", min_query_time.as_millis());
    println!("Maximum query time: {:.3}ms", max_query_time.as_millis());
    println!(
        "Transactions per second: {:.2}",
        total_transactions_received as f64 / total_duration.as_secs_f64()
    );
    println!(
        "Requests per second: {:.2}",
        request_count as f64 / total_duration.as_secs_f64()
    );
    println!("=====================================\n");

    Ok(())
}

async fn get_some_real_address_from_network(
    client: &HttpClient,
) -> Result<IotaAddress, IndexerError> {
    let mut query = IotaTransactionBlockResponseQuery::new_with_filter(
        TransactionFilter::TransactionKind(IotaTransactionKind::ProgrammableTransaction),
    );
    query.options = Some(IotaTransactionBlockResponseOptions::full_content());

    let page = client
        .query_transaction_blocks(query, None, None, None)
        .await
        .unwrap();

    let sender = *page.data[0].transaction.clone().unwrap().data.sender();

    Ok(sender)
}

async fn measure_tx_finality_time(
    client: &HttpClient,
    faucet: &RemoteFaucetClient,
    generate_event_n_times: u64,
) -> IndexerResult<()> {
    let (sender, sender_kp): (_, AccountKeyPair) = get_key_pair();
    faucet.request_iota_coins(sender).await;
    indexer_wait_for_coins(client, &sender, 1).await;

    let mut execution_times = Vec::new();
    let mut query_times = Vec::new();
    let mut late_query_times = Vec::new();
    let mut event_query_times = Vec::new();
    let mut event_query_retries = Vec::new();

    let start = std::time::Instant::now();
    for _i in 0..EXPERIMENTS_CNT {
        let (_, package_id) = deploy_basics_pkg(sender, &sender_kp, client).await;
        let basic_obj_1 = create_basic_object(sender, &sender_kp, client, &package_id).await?;
        let basic_obj_2 = create_basic_object(sender, &sender_kp, client, &package_id).await?;

        for _ in 0..generate_event_n_times {
            // Measure execution time
            let execution_start = std::time::Instant::now();
            let res = crate::coin_api::execute_move_call(
                client,
                sender,
                &sender_kp,
                package_id,
                "object_basics".to_string(),
                "update".to_string(),
                type_args![].unwrap(),
                call_args!(basic_obj_1, basic_obj_2).unwrap(),
                None,
            )
            .await
            .unwrap();
            let execution_duration = execution_start.elapsed();
            execution_times.push(execution_duration);

            assert_eq!(res.status_ok(), Some(true));

            let _event_id = res
                .events
                .as_ref()
                .unwrap()
                .data
                .iter()
                .exactly_one()
                .unwrap()
                .id;

            // Measure query time for get_transaction_block
            let query_start = std::time::Instant::now();
            let _read_result = client
                .get_transaction_block(res.digest, None)
                .await
                .unwrap();
            let query_duration = query_start.elapsed();
            query_times.push(query_duration);

            // Measure query time for events - loop until we get one result
            let event_query_start = std::time::Instant::now();
            let mut retry_count = 0;
            loop {
                let read_result = client
                    .query_events(EventFilter::Transaction(res.digest), None, None, None)
                    .await
                    .unwrap();
                if read_result.data.len() == 1 {
                    break;
                }
                retry_count += 1;
                // Small delay to avoid overwhelming the server
                tokio::time::sleep(tokio::time::Duration::from_millis(1)).await;
            }
            let event_query_duration = event_query_start.elapsed();
            event_query_times.push(event_query_duration);
            event_query_retries.push(retry_count);

            // Measure late query time for get_transaction_block
            let query_start = std::time::Instant::now();
            let _read_result = client
                .get_transaction_block(res.digest, None)
                .await
                .unwrap();
            let query_duration = query_start.elapsed();
            late_query_times.push(query_duration);
        }
    }

    let total_duration = start.elapsed();
    let total_iterations = EXPERIMENTS_CNT * generate_event_n_times;

    // Calculate execution time statistics
    let avg_execution_time =
        execution_times.iter().sum::<std::time::Duration>() / execution_times.len() as u32;
    let min_execution_time = execution_times.iter().min().unwrap();
    let max_execution_time = execution_times.iter().max().unwrap();

    // Calculate query time statistics
    let avg_query_time = query_times.iter().sum::<std::time::Duration>() / query_times.len() as u32;
    let min_query_time = query_times.iter().min().unwrap();
    let max_query_time = query_times.iter().max().unwrap();

    // Calculate late query time statistics
    let avg_late_query_time =
        late_query_times.iter().sum::<std::time::Duration>() / late_query_times.len() as u32;
    let min_late_query_time = late_query_times.iter().min().unwrap();
    let max_late_query_time = late_query_times.iter().max().unwrap();

    // Calculate event query time statistics
    let avg_event_query_time =
        event_query_times.iter().sum::<std::time::Duration>() / event_query_times.len() as u32;
    let min_event_query_time = event_query_times.iter().min().unwrap();
    let max_event_query_time = event_query_times.iter().max().unwrap();

    // Calculate event query retry statistics
    let total_retries: u32 = event_query_retries.iter().sum();
    let avg_retries = total_retries as f64 / event_query_retries.len() as f64;
    let min_retries = *event_query_retries.iter().min().unwrap();
    let max_retries = *event_query_retries.iter().max().unwrap();

    // Print detailed statistics
    println!("\n=== Transaction Finality Time Measurements ===");
    println!("Total experiments: {EXPERIMENTS_CNT}");
    println!("Events per experiment: {generate_event_n_times}");
    println!("Total iterations: {total_iterations}");
    println!("Total time: {:.3} seconds", total_duration.as_secs_f64());
    println!(
        "Average per iteration: {:.6} seconds",
        total_duration.as_secs_f64() / total_iterations as f64
    );

    println!("\n--- Execution Time Statistics ---");
    println!(
        "Average execution time: {:.3}ms",
        avg_execution_time.as_millis()
    );
    println!(
        "Minimum execution time: {:.3}ms",
        min_execution_time.as_millis()
    );
    println!(
        "Maximum execution time: {:.3}ms",
        max_execution_time.as_millis()
    );
    println!(
        "Total execution time: {:.3}s",
        execution_times
            .iter()
            .sum::<std::time::Duration>()
            .as_secs_f64()
    );

    println!("\n--- Transaction Query Time Statistics ---");
    println!("Average query time: {:.3}ms", avg_query_time.as_millis());
    println!("Minimum query time: {:.3}ms", min_query_time.as_millis());
    println!("Maximum query time: {:.3}ms", max_query_time.as_millis());
    println!(
        "Total query time: {:.3}s",
        query_times
            .iter()
            .sum::<std::time::Duration>()
            .as_secs_f64()
    );

    println!("\n--- Late Transaction Query Time Statistics ---");
    println!(
        "Average late query time: {:.3}ms",
        avg_late_query_time.as_millis()
    );
    println!(
        "Minimum late query time: {:.3}ms",
        min_late_query_time.as_millis()
    );
    println!(
        "Maximum late query time: {:.3}ms",
        max_late_query_time.as_millis()
    );
    println!(
        "Total late query time: {:.3}s",
        late_query_times
            .iter()
            .sum::<std::time::Duration>()
            .as_secs_f64()
    );

    println!("\n--- Event Query Time Statistics ---");
    println!(
        "Average event query time: {:.3}ms",
        avg_event_query_time.as_millis()
    );
    println!(
        "Minimum event query time: {:.3}ms",
        min_event_query_time.as_millis()
    );
    println!(
        "Maximum event query time: {:.3}ms",
        max_event_query_time.as_millis()
    );
    println!(
        "Total event query time: {:.3}s",
        event_query_times
            .iter()
            .sum::<std::time::Duration>()
            .as_secs_f64()
    );

    println!("\n--- Event Query Retry Statistics ---");
    println!("Total retries across all iterations: {total_retries}");
    println!("Average retries per iteration: {avg_retries:.2}");
    println!("Minimum retries per iteration: {min_retries}");
    println!("Maximum retries per iteration: {max_retries}");
    println!(
        "Iterations that required retries: {}",
        event_query_retries.iter().filter(|&&x| x > 0).count()
    );
    println!(
        "Success rate on first try: {:.1}%",
        (event_query_retries.iter().filter(|&&x| x == 0).count() as f64
            / event_query_retries.len() as f64)
            * 100.0
    );

    println!("\n--- Performance Ratios ---");
    println!(
        "Executions per second: {:.2}",
        total_iterations as f64
            / execution_times
                .iter()
                .sum::<std::time::Duration>()
                .as_secs_f64()
    );
    println!(
        "Transaction queries per second: {:.2}",
        total_iterations as f64
            / query_times
                .iter()
                .sum::<std::time::Duration>()
                .as_secs_f64()
    );
    println!(
        "Event queries per second: {:.2}",
        total_iterations as f64
            / event_query_times
                .iter()
                .sum::<std::time::Duration>()
                .as_secs_f64()
    );
    println!("===============================================\n");

    Ok(())
}

async fn benchmark_parallel_transaction_throughput(
    client: &HttpClient,
    sender: IotaAddress,
    sender_kp: &AccountKeyPair,
    gas_objects: &[ObjectID],
    basic_objects: &[(ObjectID, ObjectID)],
    package_id: ObjectID,
    concurrent_requests: usize,
    batch_count: usize,
) -> IndexerResult<()> {
    println!(
        "Starting parallel transaction throughput benchmark with {concurrent_requests} concurrent requests and {batch_count} batches"
    );

    let mut all_execution_times = Vec::new();
    let mut batch_throughputs = Vec::new();

    let total_start = std::time::Instant::now();

    for batch in 0..batch_count {
        // Run 10 batches for consistent measurements
        println!("Running batch {}/{batch_count}", batch + 1);

        let batch_start = std::time::Instant::now();
        let mut batch_execution_times = Vec::new();

        // Create futures for parallel execution
        let mut futures = Vec::new();

        for i in 0..concurrent_requests {
            let (basic_obj_1, basic_obj_2) = basic_objects[i];
            let gas_object = &gas_objects[i];
            let ca = call_args!(basic_obj_1, basic_obj_2).unwrap();
            let future = async {
                let execution_start = std::time::Instant::now();
                let result = crate::coin_api::execute_move_call(
                    client,
                    sender,
                    sender_kp,
                    package_id,
                    "object_basics".to_string(),
                    "update".to_string(),
                    type_args![].unwrap(),
                    ca,
                    Some(*gas_object),
                )
                .await;
                let execution_duration = execution_start.elapsed();
                (result, execution_duration)
            };
            futures.push(future);
        }

        // Execute all requests in parallel
        let results = join_all(futures).await;

        // Process results
        for (result, execution_time) in results {
            match result {
                Ok(res) => {
                    assert_eq!(res.status_ok(), Some(true));
                    batch_execution_times.push(execution_time);
                    all_execution_times.push(execution_time);
                }
                Err(e) => {
                    eprintln!("Transaction failed: {e:?}");
                    continue;
                }
            }
        }

        let batch_duration = batch_start.elapsed();
        let batch_tx_count = batch_execution_times.len();
        let batch_throughput = batch_tx_count as f64 / batch_duration.as_secs_f64();
        batch_throughputs.push(batch_throughput);

        println!(
            "Batch {} completed: {} transactions in {:.3}s, throughput: {:.2} tx/s",
            batch + 1,
            batch_tx_count,
            batch_duration.as_secs_f64(),
            batch_throughput
        );
    }

    let total_duration = total_start.elapsed();
    let total_transactions = all_execution_times.len();
    let overall_throughput = total_transactions as f64 / total_duration.as_secs_f64();

    // Calculate statistics
    let avg_execution_time =
        all_execution_times.iter().sum::<std::time::Duration>() / all_execution_times.len() as u32;
    let min_execution_time = all_execution_times.iter().min().unwrap();
    let max_execution_time = all_execution_times.iter().max().unwrap();

    let avg_batch_throughput =
        batch_throughputs.iter().sum::<f64>() / batch_throughputs.len() as f64;
    let min_batch_throughput = batch_throughputs
        .iter()
        .min_by(|a, b| a.partial_cmp(b).unwrap())
        .unwrap();
    let max_batch_throughput = batch_throughputs
        .iter()
        .max_by(|a, b| a.partial_cmp(b).unwrap())
        .unwrap();

    // Print comprehensive results
    println!("\n=== Parallel Transaction Throughput Benchmark Results ===");
    println!("Configuration:");
    println!("  Concurrent requests per transaction: {concurrent_requests}",);
    println!("  Number of batches: {batch_count}");
    println!("  Total parallel requests: {total_transactions}");

    println!("\nOverall Performance:");
    println!("  Total time: {:.3} seconds", total_duration.as_secs_f64());
    println!("  Overall throughput: {overall_throughput:.2} tx/s");
    println!("  Total successful transactions: {total_transactions}");

    println!("\nExecution Time Statistics:");
    println!(
        "  Average execution time: {:.3}ms",
        avg_execution_time.as_millis()
    );
    println!(
        "  Minimum execution time: {:.3}ms",
        min_execution_time.as_millis()
    );
    println!(
        "  Maximum execution time: {:.3}ms",
        max_execution_time.as_millis()
    );

    println!("\nBatch Throughput Statistics:");
    println!("  Average batch throughput: {avg_batch_throughput:.2} tx/s",);
    println!("  Minimum batch throughput: {min_batch_throughput:.2} tx/s",);
    println!("  Maximum batch throughput: {max_batch_throughput:.2} tx/s",);

    // Calculate percentiles for execution time
    let mut sorted_times = all_execution_times.clone();
    sorted_times.sort();
    let p50_idx = sorted_times.len() / 2;
    let p95_idx = (sorted_times.len() * 95) / 100;
    let p99_idx = (sorted_times.len() * 99) / 100;

    println!("\nExecution Time Percentiles:");
    println!("  P50 (median): {:.3}ms", sorted_times[p50_idx].as_millis());
    println!("  P95: {:.3}ms", sorted_times[p95_idx].as_millis());
    println!("  P99: {:.3}ms", sorted_times[p99_idx].as_millis());

    println!("=======================================================\n");

    Ok(())
}

#[tokio::test]
async fn test_parallel_transaction_throughput_node() {
    let (node_client, indexer_client, _indexer_client_wo_optimistic, faucet) =
        connect_to_rpcs_and_faucet().await;

    println!("Starting parallel transaction throughput stress test for node");

    // Test with different concurrency levels
    let test_configs = vec![(100, 50), (400, 100)];

    // Find the maximum concurrent requests needed
    let max_concurrent_requests: usize = test_configs.iter().map(|(c, _)| *c).max().unwrap();

    // Create coins and objects upfront for maximum efficiency
    let (sender, sender_kp): (_, AccountKeyPair) = get_key_pair();

    println!("Requesting multiple gas objects from faucet...");
    let mut all_faucet_coins = Vec::new();
    let mut faucet_amount = 0;
    let faucet_calls = 25;
    for i in 0..faucet_calls {
        println!(
            "Requesting coin batch {}/{faucet_calls} from faucet...",
            i + 1
        );
        let faucet_res = faucet.request_iota_coins(sender).await;
        faucet_amount = faucet_res.transferred_gas_objects.first().unwrap().amount;
        all_faucet_coins.extend(
            faucet_res
                .transferred_gas_objects
                .into_iter()
                .map(|obj| obj.id),
        );
    }

    println!("Waiting for coin being indexed");
    indexer_wait_for_coins(&node_client, &sender, all_faucet_coins.len() as u32).await;

    println!(
        "Splitting {} coins into {} smaller coins for parallel testing...",
        all_faucet_coins.len(),
        max_concurrent_requests
    );

    // Calculate how many coins to create from each faucet coin
    let coins_per_split = max_concurrent_requests.div_ceil(all_faucet_coins.len());
    let gas_budget = 200_000_000; // 0.05 IOTA for each split operation
    let amount_per_coin = (faucet_amount - gas_budget * 2) / coins_per_split as u64;

    let mut all_gas_coins = Vec::new();

    // Split each faucet coin into smaller coins
    for (i, faucet_coin) in all_faucet_coins.iter().enumerate() {
        let coins_to_create = std::cmp::min(
            coins_per_split,
            max_concurrent_requests - all_gas_coins.len(),
        );

        println!(
            "Splitting coin {}/{} into {} parts of {}...",
            i + 1,
            all_faucet_coins.len(),
            coins_to_create,
            amount_per_coin
        );
        let split_coins = split_coin_into_many(
            &node_client,
            sender,
            &sender_kp,
            *faucet_coin,
            coins_to_create,
            amount_per_coin,
            gas_budget,
        )
        .await
        .unwrap();

        all_gas_coins.extend(split_coins);
    }

    println!("Deploying package and creating objects...");
    let (_, package_id) = deploy_basics_pkg(sender, &sender_kp, &node_client).await;

    // Create multiple basic objects for parallel operations (these make
    // transactions different)
    let mut basic_objects = Vec::new();

    // Create futures for parallel object creation, but limit to 100 concurrent
    // requests to avoid overwhelming the system
    let batch_size = 100;
    for chunk_start in (0..max_concurrent_requests).step_by(batch_size) {
        let chunk_end = std::cmp::min(chunk_start + batch_size, max_concurrent_requests);
        let chunk_size = chunk_end - chunk_start;

        let mut object_creation_futures = Vec::new();
        for i in 0..chunk_size {
            let gas_coin_1 = all_gas_coins[chunk_start + i];
            let future1 = create_basic_object_with_gas(
                sender,
                &sender_kp,
                &node_client,
                &package_id,
                gas_coin_1,
                (chunk_start + i) as u64,
            );
            let future2 = create_basic_object_with_gas(
                sender,
                &sender_kp,
                &node_client,
                &package_id,
                gas_coin_1,
                (max_concurrent_requests + chunk_start + i) as u64,
            );
            object_creation_futures.push(async move {
                let basic_obj_1 = future1.await.unwrap();
                let basic_obj_2 = future2.await.unwrap();
                (basic_obj_1, basic_obj_2)
            });
        }

        // Execute batch in parallel
        let created_objects = join_all(object_creation_futures).await;
        basic_objects.extend(created_objects);

        println!(
            "Created {} object pairs (total: {}/{})",
            chunk_size,
            basic_objects.len(),
            max_concurrent_requests
        );
    }

    println!("Setup complete. Starting benchmark tests...");

    for (concurrent_requests, transactions_per_batch) in test_configs {
        println!(
            "\n--- Testing {concurrent_requests} concurrent requests with {transactions_per_batch} transactions per batch ---",
        );

        println!("Running benchmark for NODE...");
        benchmark_parallel_transaction_throughput(
            &node_client,
            sender,
            &sender_kp,
            &all_gas_coins[..concurrent_requests],
            &basic_objects[..concurrent_requests],
            package_id,
            concurrent_requests,
            transactions_per_batch,
        )
        .await
        .unwrap();

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        println!("Running benchmark for INDEXER...");
        benchmark_parallel_transaction_throughput(
            &indexer_client,
            sender,
            &sender_kp,
            &all_gas_coins[..concurrent_requests],
            &basic_objects[..concurrent_requests],
            package_id,
            concurrent_requests,
            transactions_per_batch,
        )
        .await
        .unwrap();

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn test_measure_tx_finality_time_indexer() {
    let (_node_client, indexer_client, _indexer_client_wo_optimistic, faucet) =
        connect_to_rpcs_and_faucet().await;

    println!("Testing transaction finality time with indexer client");
    measure_tx_finality_time(&indexer_client, &faucet, 10)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_measure_tx_finality_time_node() {
    let (node_client, _indexer_client, _indexer_client_wo_optimistic, faucet) =
        connect_to_rpcs_and_faucet().await;

    println!("Testing transaction finality time with node client");
    measure_tx_finality_time(&node_client, &faucet, 10)
        .await
        .unwrap();
}
