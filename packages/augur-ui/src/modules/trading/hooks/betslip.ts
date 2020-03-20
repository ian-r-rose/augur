import { useState, useReducer, createContext } from 'react';
import { getTheme } from 'modules/app/actions/update-app-status';
import { THEMES } from 'modules/common/constants';
import { StaticLabelDropdown } from 'modules/common/selection';

export const BETSLIP_OPTIONS = {
  0: { label: 'Betslip', emptyHeader: `Betslip is empty` },
  1: { label: 'My Bets', emptyHeader: `You don't have any bets` },
};

const BETSLIP_AMOUNT_ACTIONS = {
  INC_BETSLIP_AMOUNT: 'INC_BETSLIP_AMOUNT',
  DEC_BETSLIP_AMOUNT: 'DEC_BETSLIP_AMOUNT',
  INC_MYBETS_AMOUNT: 'INC_MYBETS_AMOUNT',
  DEC_MYBETS_AMOUNT: 'DEC_MYBETS_AMOUNT',
  CLEAR_BETSLIP_AMOUNT: 'CLEAR_BETSLIP_AMOUNT',
};

function betslipAmountReducer(state, action) {
  const {
    INC_BETSLIP_AMOUNT,
    INC_MYBETS_AMOUNT,
    DEC_BETSLIP_AMOUNT,
    DEC_MYBETS_AMOUNT,
    CLEAR_BETSLIP_AMOUNT,
  } = BETSLIP_AMOUNT_ACTIONS;
  switch (action.type) {
    case INC_BETSLIP_AMOUNT:
      return { ...state, betslipAmount: state.betslipAmount + 1 };
    case DEC_BETSLIP_AMOUNT:
      return { ...state, betslipAmount: state.betslipAmount - 1 };
    case INC_MYBETS_AMOUNT:
      return { ...state, myBetsAmount: state.myBetsAmount + 1 };
    case DEC_MYBETS_AMOUNT:
      return { ...state, myBetsAmount: state.myBetsAmount - 1 };
    case CLEAR_BETSLIP_AMOUNT:
      return { ...state, betslipAmount: 0 };
    default:
      throw new Error('invalid dispatch to betslipAmountReducer');
  }
}

const BETSLIP_ORDERS_ACTIONS = {
  ADD: 'ADD',
  REMOVE: 'REMOVE',
  MODIFY: 'MODIFY',
  SEND: 'SEND',
  SEND_ALL: 'SEND_ALL',
  CLEAR_ALL: 'CLEAR_ALL',
};

const BETSLIP_ORDER_DEFAULT_STATE = {
  bettingTextValues: {},
  confirmationDetails: {},
  orderCount: 0,
  orders: {},
};

const MOCK_TEST_BETSLIP_ORDER_STATE = {
  bettingTextValues: {
    betting: '30',
    potential: '28.18',
  },
  confirmationDetails: {
    wager: '30',
    fees: '1.50',
  },
  orderCount: 3,
  orders: {
    '0x01': {
      description: 'CHICAGO BULLS vs BROOKLYN NETS, SPREAD',
      orders: [
        {
          outcome: 'Chicogo Bulls, +5',
          odds: '-105',
          wager: '10.00',
          toWin: '9.52',
          marketId: '0x01',
        },
        {
          outcome: 'Brooklyn Nets, -5',
          odds: '+115',
          wager: '10.00',
          toWin: '19.52',
          marketId: '0x01',
        },
      ],
    },
    '0x02': {
      description: 'DALLAS MAVERICKS vs HOUSTON ROCKETS, SPREAD',
      orders: [
        {
          outcome: 'Houston Rockets, -8.5',
          odds: '-110',
          wager: '10.00',
          toWin: '9.09',
          marketId: '0x02',
        },
      ],
    },
  },
};

function betslipOrdersReducer(state, action) {
  const {
    ADD,
    REMOVE,
    MODIFY,
    SEND,
    SEND_ALL,
    CLEAR_ALL,
  } = BETSLIP_ORDERS_ACTIONS;
  switch (action.type) {
    case ADD: {
      console.log(ADD, action.marketId, action.description, action.order);
      return state;
    }
    case REMOVE: {
      const { marketId, orderId } = action;
      const updatedState = { ...state };
      const market = updatedState.orders[marketId];
      market.orders.splice(orderId, 1);
      if (market.orders.length === 0) {
        delete updatedState.orders[marketId];
      }
      updatedState.orderCount--;
      return updatedState;
    }
    case MODIFY: {
      const { marketId, orderId, order } = action;
      const updatedState = { ...state };
      updatedState.orders[marketId].orders[orderId] = order;
      return updatedState;
    }
    case SEND: {
      console.log(SEND, action.marketId, action.orderId);
      return state;
    }
    case SEND_ALL: {
      console.log(SEND_ALL);
      return state;
    }
    case CLEAR_ALL:
      return BETSLIP_ORDER_DEFAULT_STATE;
    default:
      throw new Error('invalid dispatch to betslipOrdersReducer');
  }
}

export const SelectedContext = createContext({ header: 0, subHeader: 0 });
export const BetslipStepContext = createContext(0);

export const useSelected = (defaultSelected = { header: 0, subHeader: 0 }) => {
  const [selected, setSelected] = useState(defaultSelected);
  const nextSelection = selected.header === 0 ? 1 : 0;
  const nextSubSelection = selected.subHeader === 0 ? 1 : 0;

  return {
    selected,
    ...BETSLIP_OPTIONS[selected.header],
    toggleHeaderSelected: selectedClicked => {
      const isSports = getTheme() === THEMES.SPORTS;
      if (selectedClicked === nextSelection)
        setSelected({ subHeader: isSports ? 1 : selected.subHeader, header: nextSelection });
    },
    toggleSubHeaderSelected: selectedClicked => {
      const isSports = getTheme() === THEMES.SPORTS;
      if (selectedClicked === nextSubSelection)
        setSelected({ ...selected, subHeader: isSports ? 1 : nextSubSelection });
    },
  };
};

export const useBetslipAmounts = (
  selected: number,
  defaultState = { betslipAmount: 0, myBetsAmount: 0 }
) => {
  const [state, dispatch] = useReducer(betslipAmountReducer, defaultState);
  const isSelectedEmpty =
    selected === 0 ? state.betslipAmount === 0 : state.myBetsAmount === 0;
  const {
    INC_BETSLIP_AMOUNT,
    INC_MYBETS_AMOUNT,
    DEC_BETSLIP_AMOUNT,
    DEC_MYBETS_AMOUNT,
    CLEAR_BETSLIP_AMOUNT,
  } = BETSLIP_AMOUNT_ACTIONS;

  return {
    betslipAmount: state.betslipAmount,
    myBetsAmount: state.myBetsAmount,
    isSelectedEmpty,
    incBetslipAmount: () => dispatch({ type: INC_BETSLIP_AMOUNT }),
    incMyBetslipAmount: () => dispatch({ type: INC_MYBETS_AMOUNT }),
    decBetslipAmount: () => dispatch({ type: DEC_BETSLIP_AMOUNT }),
    decMyBetslipAmount: () => dispatch({ type: DEC_MYBETS_AMOUNT }),
    clearBetslipAmount: () => dispatch({ type: CLEAR_BETSLIP_AMOUNT }),
  };
};

export const useBetslip = (
  selected,
  defaultState = MOCK_TEST_BETSLIP_ORDER_STATE
) => {
  const [state, dispatch] = useReducer(betslipOrdersReducer, defaultState);
  const betslipAmounts = useBetslipAmounts(selected, {
    betslipAmount: state.orderCount,
    myBetsAmount: 0,
  });
  const {
    ADD,
    REMOVE,
    MODIFY,
    SEND,
    SEND_ALL,
    CLEAR_ALL,
  } = BETSLIP_ORDERS_ACTIONS;

  return {
    ordersInfo: state,
    ordersActions: {
      addOrder: (marketId, description, order) => {
        dispatch({ type: ADD, marketId, description, order });
        betslipAmounts.incBetslipAmount();
      },
      removeOrder: (marketId, orderId) => {
        dispatch({ type: REMOVE, marketId, orderId });
        betslipAmounts.decBetslipAmount();
      },
      modifyOrder: (marketId, order) => {
        dispatch({ type: MODIFY, marketId, order });
      },
      sendOrder: (marketId, orderId) => {
        dispatch({ type: SEND, marketId, orderId });
      },
      sendAllOrders: () => {
        dispatch({ type: SEND_ALL });
      },
      cancelAllOrders: () => {
        dispatch({ type: CLEAR_ALL });
        betslipAmounts.clearBetslipAmount();
      },
    },
    ...betslipAmounts,
  };
};
