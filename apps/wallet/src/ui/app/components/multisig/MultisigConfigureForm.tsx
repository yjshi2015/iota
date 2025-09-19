// Copyright (c) 2025 IOTA Stiftung
// SPDX-License-Identifier: Apache-2.0

import { useZodForm, toast } from '@iota/core';
import classNames from 'clsx';
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
    Dialog,
    DialogContent,
    Header,
    DialogBody,
    InfoBox,
    InfoBoxStyle,
    InfoBoxType,
} from '@iota/apps-ui-kit';
import {
    weightedPubKeyValidation,
    thresholdValidation,
} from '../../helpers/validation/multisigConfigValidation';
import { useEffect, useState } from 'react';
import { Close, QrCode, Warning } from '@iota/apps-ui-icons';
import { UR } from '@keystonehq/keystone-sdk';
import { AnimatedQRCode, AnimatedQRScanner } from '@keystonehq/animated-qr';
import { Ed25519PublicKey } from '@iota/iota-sdk/keypairs/ed25519';
import { publicKeyFromIotaBytes } from '@iota/iota-sdk/verify';
import { useCheckCameraPermissionStatus } from '../../hooks';

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
    const ourPubKeyWithFlag = new Ed25519PublicKey(ourPubKey).toIotaPublicKey();
    const form = useZodForm({
        mode: 'all',
        reValidateMode: 'onChange',
        schema: formSchema,
        defaultValues: {
            threshold: 2,
            pubKeys: [{ pubKey: ourPubKeyWithFlag, weight: 1 }],
        },
    });

    const [isPublicKeyQrModalOpen, setIsPublicKeyQrModalOpen] = useState(false);
    const [isQrScannerModalOpen, setIsQrScannerModalOpen] = useState(false);
    const [scanningForIndex, setScanningForIndex] = useState<number | null>(null);
    const [cameraPermissionStatus] = useCheckCameraPermissionStatus();

    const {
        register,
        formState: { isSubmitting, isValid, errors },
        watch,
        setValue,
        trigger,
    } = form;

    const pubKeys = watch('pubKeys');

    const addPubKey = () => {
        if (pubKeys.length < 10) {
            const newPubKeys = [...pubKeys, { pubKey: '', weight: 1 }];
            setValue('pubKeys', newPubKeys, { shouldValidate: true });
        }
    };

    const removePubKey = (index: number) => {
        if (pubKeys.length > 1) {
            const newPubKeys = pubKeys.filter((_, i) => i !== index);
            setValue('pubKeys', newPubKeys, { shouldValidate: true });
        }
    };

    const handleFormSubmit = (data: FormValues) => {
        onSubmit(data);
    };

    const openQrScanner = (index: number) => {
        setScanningForIndex(index);
        setIsQrScannerModalOpen(true);
    };

    const onQrScanSuccess = (data: any) => {
        try {
            if (scanningForIndex !== null) {
                let pubKeyBase64: string = '';

                if (data.cbor) {
                    // CBOR data is a hex string, convert it to bytes first
                    const cborHex = data.cbor;
                    const cborBytes = new Uint8Array(
                        cborHex.match(/.{2}/g)!.map((byte: string) => parseInt(byte, 16)),
                    );

                    // Create a UR from the CBOR bytes and decode it
                    const ur = new UR(Buffer.from(cborBytes), 'bytes');
                    const decodedBuffer = ur.decodeCBOR();
                    pubKeyBase64 = new TextDecoder().decode(decodedBuffer);
                } else {
                    throw new Error('Unsupported QR code format');
                }

                const otherPubKey = publicKeyFromIotaBytes(pubKeyBase64);
                const iotaPublicKey = otherPubKey.toIotaPublicKey();

                // Update the form value
                setValue(`pubKeys.${scanningForIndex}.pubKey`, iotaPublicKey, {
                    shouldValidate: true,
                });

                // Close modal and reset state
                setIsQrScannerModalOpen(false);
                setScanningForIndex(null);
                toast.success('Public key scanned successfully!');
            }
        } catch (error) {
            console.error('QR scan error:', error);
            console.error('QR scan data:', data);
            toast.error(
                `Invalid public key QR code. Data: ${JSON.stringify(data)}. Error: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    };

    const onQrScanError = (error: string) => {
        console.error('QR scan error from scanner:', error);
        toast.error(`QR scan error: ${error}`);
    };

    const totalWeight = pubKeys.reduce((sum, pk) => {
        const weight = typeof pk.weight === 'string' ? parseInt(pk.weight) || 0 : pk.weight;
        return sum + weight;
    }, 0);

    useEffect(() => {
        trigger('threshold');
    }, [totalWeight, trigger]);

    const ourPubKeyUR = UR.from(Buffer.from(ourPubKeyWithFlag));

    return (
        <>
            <Form className="flex h-full flex-col" form={form} onSubmit={handleFormSubmit}>
                <div className="flex-shrink-0">
                    <Input
                        type={InputType.Text}
                        label="Threshold"
                        min="1"
                        max="10"
                        {...register('threshold')}
                        errorMessage={errors.threshold?.message}
                    />
                </div>

                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="my-4 flex flex-shrink-0 items-center justify-between">
                        <label className="block text-sm font-medium text-gray-700">
                            <span className="ml-2 text-sm text-gray-500">
                                Total Weight: {totalWeight}
                            </span>
                        </label>
                        <Button
                            text="Add Public Key"
                            size={ButtonSize.Small}
                            onClick={addPubKey}
                            disabled={pubKeys.length >= 10}
                        />
                    </div>

                    <div className="max-h-[390px] flex-1 space-y-2 overflow-y-auto pr-1">
                        {pubKeys.map((pubKey, index) => (
                            <div
                                key={index}
                                className={classNames('rounded-lg border border-gray-200 p-2', {
                                    'border-green-200': pubKey.pubKey === ourPubKeyWithFlag,
                                })}
                            >
                                <div className="mb-1 flex items-center justify-between">
                                    <h4
                                        className={classNames('font-medium text-gray-700', {
                                            'text-green-500': pubKey.pubKey === ourPubKeyWithFlag,
                                        })}
                                    >
                                        {pubKey.pubKey === ourPubKeyWithFlag
                                            ? 'Your Public Key'
                                            : `Key #${index + 1}`}
                                    </h4>
                                    {pubKey.pubKey === ourPubKeyWithFlag && (
                                        <Button
                                            size={ButtonSize.Small}
                                            type={ButtonType.Secondary}
                                            onClick={() => setIsPublicKeyQrModalOpen(true)}
                                            text="Show QR"
                                        />
                                    )}
                                    {pubKeys.length > 1 && pubKey.pubKey !== ourPubKeyWithFlag && (
                                        <Button
                                            size={ButtonSize.Small}
                                            type={ButtonType.Destructive}
                                            onClick={() => removePubKey(index)}
                                            icon={<Close />}
                                        />
                                    )}
                                </div>

                                <div className="md:grid-cols-4 grid grid-cols-1 gap-2">
                                    <div className="md:col-span-2">
                                        <Input
                                            type={InputType.Text}
                                            placeholder="Enter public key"
                                            disabled={pubKey.pubKey === ourPubKeyWithFlag}
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

                                    {pubKey.pubKey !== ourPubKeyWithFlag && (
                                        <div className="flex items-end">
                                            <Button
                                                size={ButtonSize.Small}
                                                type={ButtonType.Secondary}
                                                onClick={() => openQrScanner(index)}
                                                icon={<QrCode />}
                                                text="Scan QR"
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="mt-4 flex-shrink-0 pt-4">
                    <Button
                        htmlType={ButtonHtmlType.Submit}
                        type={ButtonType.Primary}
                        disabled={isSubmitting || !isValid}
                        fullWidth={true}
                        text={isSubmitting ? 'Submitting...' : 'Submit'}
                    />
                </div>
            </Form>
            <PublicKeyQrModal
                isOpen={isPublicKeyQrModalOpen}
                setOpen={(open) => setIsPublicKeyQrModalOpen(open)}
                pubKeyUR={ourPubKeyUR}
            />
            <QrScannerModal
                isOpen={isQrScannerModalOpen}
                setOpen={setIsQrScannerModalOpen}
                onSuccess={onQrScanSuccess}
                onError={onQrScanError}
                cameraPermissionStatus={cameraPermissionStatus}
            />
        </>
    );
}

interface PublicKeyQrModalProps {
    isOpen: boolean;
    setOpen: (isOpen: boolean) => void;
    pubKeyUR: UR;
}

export function PublicKeyQrModal({ isOpen, setOpen, pubKeyUR }: PublicKeyQrModalProps) {
    return (
        <Dialog open={isOpen} onOpenChange={setOpen}>
            <DialogContent containerId="overlay-portal-container">
                <Header title="Public Key" onClose={() => setOpen(false)} />
                <DialogBody>
                    <div className="flex h-full flex-col items-center justify-center gap-xs">
                        <AnimatedQRCode
                            type={pubKeyUR.type}
                            cbor={pubKeyUR.cbor.toString('hex')}
                            options={{ size: 280, capacity: 1000 }}
                        />
                        <span className="text-title-xs mt-4 text-iota-neutral-10 dark:text-iota-neutral-92">
                            Scan this QR to get the Public Key of this account
                        </span>
                    </div>
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}

interface QrScannerModalProps {
    isOpen: boolean;
    setOpen: (isOpen: boolean) => void;
    onSuccess: (data: any) => void;
    onError: (error: string) => void;
    cameraPermissionStatus: string | null;
}

export function QrScannerModal({
    isOpen,
    setOpen,
    onSuccess,
    onError,
    cameraPermissionStatus,
}: QrScannerModalProps) {
    const canShowQrScanner = cameraPermissionStatus && cameraPermissionStatus !== 'denied';

    return (
        <Dialog open={isOpen} onOpenChange={setOpen}>
            <DialogContent containerId="overlay-portal-container">
                <Header title="Scan Public Key QR Code" onClose={() => setOpen(false)} />
                <DialogBody>
                    <div className="flex h-full flex-col items-center justify-center gap-xs">
                        {canShowQrScanner ? (
                            <>
                                <div className="relative box-border flex h-[280px] w-[280px] items-center justify-center overflow-hidden rounded-lg">
                                    <div className="flex-shrink-0">
                                        <AnimatedQRScanner
                                            handleScan={onSuccess}
                                            handleError={onError}
                                            options={{
                                                blur: true,
                                                width: '280px',
                                                height: '280px',
                                            }}
                                            urTypes={['bytes']}
                                        />
                                    </div>
                                </div>
                                <span className="text-center text-body-sm text-iota-neutral-40 dark:text-iota-neutral-60">
                                    Point your camera at a QR code containing a public key
                                </span>
                            </>
                        ) : (
                            <InfoBox
                                title="Camera Access Blocked!"
                                supportingText="Please allow camera access, then try again to proceed."
                                style={InfoBoxStyle.Elevated}
                                type={InfoBoxType.Error}
                                icon={<Warning />}
                            />
                        )}
                    </div>
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}
