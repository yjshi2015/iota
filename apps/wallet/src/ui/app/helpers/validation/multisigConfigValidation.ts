// Copyright (c) 2025 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const thresholdValidation = z
    .string()
    .transform((val) => parseInt(val) || 0)
    .pipe(
        z.number().min(1, 'Threshold must be at least 1.').max(10, 'Threshold cannot exceed 10.'),
    );

export const weightedPubKeyValidation = z
    .array(
        z.object({
            pubKey: z
                .string()
                .trim()
                .min(2, 'Public key is required.')
                .regex(
                    /^[A-Za-z0-9+/]{43}=$/,
                    'Invalid public key, must be a 44-character base64 string ending with =.',
                ),
            weight: z
                .string()
                .transform((val) => parseInt(val) || 0)
                .pipe(
                    z
                        .number()
                        .min(1, 'Weight must be at least 1.')
                        .max(10, 'Weight cannot exceed 10.'),
                ),
        }),
    )
    .min(2, 'At least two public keys are required.')
    .max(10, 'Cannot have more than 10 public keys.')
    .refine(
        (pubKeys) => {
            const weights = pubKeys.map((pk) =>
                typeof pk.weight === 'string' ? parseInt(pk.weight) || 0 : pk.weight,
            );
            return weights.every((weight) => weight >= 1 && weight <= 10);
        },
        {
            message: 'All weights must be between 1 and 10',
        },
    );
