import { BigNumber } from 'ethers';

const ZERO = BigNumber.from('0');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const NOT_ZERO_ADDRESS = '0x0000000000000000000000000000000000000001';
const MAX_INT_256 = BigNumber.from('2').pow('255').sub(1);
const MAX_UINT_256 = BigNumber.from('2').pow('256').sub(1);
const MIN_INT_256 = BigNumber.from('-0x8000000000000000000000000000000000000000000000000000000000000000');

export default {
  ZERO,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  NOT_ZERO_ADDRESS,
  MAX_INT_256,
  MIN_INT_256,
  MAX_UINT_256,
};
