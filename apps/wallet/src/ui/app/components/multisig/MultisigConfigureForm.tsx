// Copyright (c) 2025 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { useZodForm } from '@iota/core';
import { type SubmitHandler } from 'react-hook-form';
import { z } from 'zod';

import { Form } from '../../shared/forms/Form';
import {
    Button,
    ButtonType,
    ButtonHtmlType,
    Input,
    InputType,
    ButtonSize,
} from '@iota/apps-ui-kit';
import {
    weightedPubKeyValidation,
    thresholdValidation,
} from '../../helpers/validation/multisigConfigValidation';

const formSchema = z
    .object({
        threshold: thresholdValidation,
        pubKeys: weightedPubKeyValidation,
    })
    .refine(
        (data) => {
            const threshold =
                typeof data.threshold === 'string' ? parseInt(data.threshold) || 0 : data.threshold;
            const totalWeight = data.pubKeys.reduce((sum, pk) => {
                const weight = typeof pk.weight === 'string' ? parseInt(pk.weight) || 0 : pk.weight;
                return sum + weight;
            }, 0);
            return threshold <= totalWeight;
        },
        {
            message: 'Threshold must not exceed the sum of all weights',
            path: ['threshold'],
        },
    );

type FormValues = z.infer<typeof formSchema>;

interface MultisigConfigFormProps {
    onSubmit: SubmitHandler<FormValues>;
    ourPubKey: string;
}

export function MultisigConfigureForm({ onSubmit, ourPubKey }: MultisigConfigFormProps) {
    const form = useZodForm({
        mode: 'onChange',
        schema: formSchema,
        defaultValues: {
            threshold: 2,
            pubKeys: [{ pubKey: ourPubKey, weight: 1 }],
        },
    });

    const {
        register,
        formState: { isSubmitting, isValid, errors },
        watch,
        setValue,
    } = form;

    const pubKeys = watch('pubKeys') || [];
    const threshold = watch('threshold');

    const addPubKey = () => {
        if (pubKeys.length < 10) {
            const newPubKeys = [...pubKeys, { pubKey: '', weight: 1 }];
            setValue('pubKeys', newPubKeys);
        }
    };

    const removePubKey = (index: number) => {
        if (pubKeys.length > 1) {
            const newPubKeys = pubKeys.filter((_, i) => i !== index);
            setValue('pubKeys', newPubKeys);
        }
    };

    const handleFormSubmit = (data: FormValues) => {
        onSubmit(data);
    };

    const totalWeight = pubKeys.reduce((sum, pk) => {
        const weight = typeof pk.weight === 'string' ? parseInt(pk.weight) || 0 : pk.weight;
        return sum + weight;
    }, 0);

    return (
        <Form className="flex flex-col gap-1" form={form} onSubmit={handleFormSubmit}>
            <Input
                type={InputType.Text}
                label="Threshold"
                min="1"
                max="10"
                {...register('threshold')}
                errorMessage={errors.threshold?.message}
            />

            <div>
                <div className="mb-2 flex items-center justify-between">
                    <label className="block text-sm font-medium text-gray-700">
                        Public Keys ({pubKeys.length}/10)
                        <span className="ml-2 text-sm text-gray-500">
                            Total Weight: {totalWeight}
                        </span>
                    </label>
                    <Button
                        text="Add Key"
                        size={ButtonSize.Small}
                        onClick={addPubKey}
                        disabled={pubKeys.length >= 10}
                    />
                </div>

                <div className="space-y-2">
                    {pubKeys.map((pubKey, index) => (
                        <div key={index} className="rounded-lg border border-gray-200 p-2">
                            <div className="mb-1 flex items-center justify-between">
                                <h4 className="font-medium text-gray-700">Key #{index + 1}</h4>
                                {pubKeys.length > 1 && pubKey.pubKey !== ourPubKey && (
                                    <Button
                                        text="X"
                                        onClick={() => removePubKey(index)}
                                        disabled={false}
                                    />
                                )}
                            </div>

                            <div className="md:grid-cols-3 grid grid-cols-1 gap-4">
                                <div className="md:col-span-2">
                                    <Input
                                        type={InputType.Text}
                                        label="Public Key"
                                        placeholder="0x..."
                                        disabled={pubKey.pubKey === ourPubKey}
                                        {...register(`pubKeys.${index}.pubKey`)}
                                        errorMessage={errors.pubKeys?.[index]?.pubKey?.message}
                                    />
                                </div>

                                <div>
                                    <Input
                                        type={InputType.Number}
                                        label="Weight"
                                        min="1"
                                        max="10"
                                        {...register(`pubKeys.${index}.weight`)}
                                        errorMessage={errors.pubKeys?.[index]?.weight?.message}
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className="pt-4">
                <Button
                    htmlType={ButtonHtmlType.Submit}
                    type={ButtonType.Primary}
                    disabled={isSubmitting || !isValid}
                    fullWidth={true}
                    text={isSubmitting ? 'Submitting...' : 'Submit Configuration'}
                />

                {!isValid && (
                    <p className="mt-2 text-sm text-amber-600">
                        Please fix validation errors before submitting
                    </p>
                )}
            </div>
            <h3 className="mb-2 font-medium text-gray-700">Debug Info:</h3>
            <div className="md:grid-cols-2 grid grid-cols-1 gap-4 text-sm">
                <div>
                    <strong>Form Valid:</strong> {isValid ? 'Yes' : 'No'}
                </div>
                <div>
                    <strong>Threshold:</strong> {threshold}
                </div>
                <div>
                    <strong>Total Weight:</strong> {totalWeight}
                </div>
                <div>
                    <strong>Keys Count:</strong> {pubKeys.length}
                </div>
            </div>
        </Form>
    );
}
