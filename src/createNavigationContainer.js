import React from 'react';
import { Linking, AsyncStorage } from 'react-native';
import withLifecyclePolyfill from 'react-lifecycles-compat';

import { BackHandler } from './PlatformHelpers';
import NavigationActions from './NavigationActions';
import invariant from './utils/invariant';
import docsUrl from './utils/docsUrl';

function isStateful(props) {
  return !props.navigation;
}

function validateProps(props) {
  if (isStateful(props)) {
    return;
  }

  const { navigation, screenProps, ...containerProps } = props;

  const keys = Object.keys(containerProps);

  if (keys.length !== 0) {
    throw new Error(
      'This navigator has both navigation and container props, so it is ' +
        `unclear if it should own its own state. Remove props: "${keys.join(
          ', '
        )}" ` +
        'if the navigator should get its state from the navigation prop. If the ' +
        'navigator should maintain its own state, do not pass a navigation prop.'
    );
  }
}

// Track the number of stateful container instances. Warn if >0 and not using the
// detached prop to explicitly acknowledge the behavior. We should deprecated implicit
// stateful navigation containers in a future release and require a provider style pattern
// instead in order to eliminate confusion entirely.
let _statefulContainerCount = 0;
export function _TESTING_ONLY_reset_container_count() {
  _statefulContainerCount = 0;
}

// We keep a global flag to catch errors during the state persistence hydrating scenario.
// The innermost navigator who catches the error will dispatch a new init action.
let _reactNavigationIsHydratingState = false;
// Unfortunate to use global state here, but it seems necessesary for the time
// being. There seems to be some problems with cascading componentDidCatch
// handlers. Ideally the inner non-stateful navigator catches the error and
// re-throws it, to be caught by the top-level stateful navigator.

/**
 * Create an HOC that injects the navigation and manages the navigation state
 * in case it's not passed from above.
 * This allows to use e.g. the StackNavigator and TabNavigator as root-level
 * components.
 */
export default function createNavigationContainer(Component) {
  class NavigationContainer extends React.Component {
    subs = null;

    static router = Component.router;
    static navigationOptions = null;

    static getDerivedStateFromProps(nextProps, prevState) {
      validateProps(nextProps);
      return null;
    }

    _actionEventSubscribers = new Set();

    constructor(props) {
      super(props);

      validateProps(props);

      this._initialAction = NavigationActions.init();

      if (this._isStateful()) {
        this.subs = BackHandler.addEventListener('hardwareBackPress', () => {
          if (!this._isMounted) {
            this.subs && this.subs.remove();
          } else {
            // dispatch returns true if the action results in a state change,
            // and false otherwise. This maps well to what BackHandler expects
            // from a callback -- true if handled, false if not handled
            return this.dispatch(NavigationActions.back());
          }
        });
      }

      this.state = {
        nav:
          this._isStateful() && !props.persistenceKey
            ? Component.router.getStateForAction(this._initialAction)
            : null,
      };
    }

    _renderLoading() {
      return this.props.renderLoadingExperimental
        ? this.props.renderLoadingExperimental()
        : null;
    }

    _isStateful() {
      return isStateful(this.props);
    }

    _validateProps(props) {
      if (this._isStateful()) {
        return;
      }

      const { navigation, screenProps, ...containerProps } = props;

      const keys = Object.keys(containerProps);

      if (keys.length !== 0) {
        throw new Error(
          'This navigator has both navigation and container props, so it is ' +
            `unclear if it should own its own state. Remove props: "${keys.join(
              ', '
            )}" ` +
            'if the navigator should get its state from the navigation prop. If the ' +
            'navigator should maintain its own state, do not pass a navigation prop.'
        );
      }
    }

    _urlToPathAndParams(url) {
      const params = {};
      const delimiter = this.props.uriPrefix || '://';
      let path = url.split(delimiter)[1];
      if (typeof path === 'undefined') {
        path = url;
      } else if (path === '') {
        path = '/';
      }
      return {
        path,
        params,
      };
    }

    _handleOpenURL = ({ url }) => {
      const parsedUrl = this._urlToPathAndParams(url);
      if (parsedUrl) {
        const { path, params } = parsedUrl;
        const action = Component.router.getActionForPathAndParams(path, params);
        if (action) {
          this.dispatch(action);
        }
      }
    };

    _onNavigationStateChange(prevNav, nav, action) {
      if (
        typeof this.props.onNavigationStateChange === 'undefined' &&
        this._isStateful() &&
        !!process.env.REACT_NAV_LOGGING
      ) {
        /* eslint-disable no-console */
        if (console.group) {
          console.group('Navigation Dispatch: ');
          console.log('Action: ', action);
          console.log('New State: ', nav);
          console.log('Last State: ', prevNav);
          console.groupEnd();
        } else {
          console.log('Navigation Dispatch: ', {
            action,
            newState: nav,
            lastState: prevNav,
          });
        }
        /* eslint-enable no-console */
        return;
      }

      if (typeof this.props.onNavigationStateChange === 'function') {
        this.props.onNavigationStateChange(prevNav, nav, action);
      }
    }

    componentDidUpdate() {
      // Clear cached _nav every tick
      if (this._nav === this.state.nav) {
        this._nav = null;
      }
    }

    async componentDidMount() {
      this._isMounted = true;
      if (!this._isStateful()) {
        return;
      }

      if (__DEV__ && !this.props.detached) {
        if (_statefulContainerCount > 0) {
          console.error(
            `You should only render one navigator explicitly in your app, and other navigators should by rendered by including them in that navigator. Full details at: ${docsUrl(
              'common-mistakes.html#explicitly-rendering-more-than-one-navigator'
            )}`
          );
        }
      }
      _statefulContainerCount++;
      Linking.addEventListener('url', this._handleOpenURL);

      const { persistenceKey } = this.props;
      const startupStateJSON =
        persistenceKey && (await AsyncStorage.getItem(persistenceKey));
      let startupState = this.state.nav;
      if (startupStateJSON) {
        try {
          startupState = JSON.parse(startupStateJSON);
          _reactNavigationIsHydratingState = true;
        } catch (e) {}
      }

      let action = this._initialAction;
      if (!startupState) {
        !!process.env.REACT_NAV_LOGGING &&
          console.log('Init new Navigation State');
        startupState = Component.router.getStateForAction(action);
      }

      const url = await Linking.getInitialURL();
      const parsedUrl = url && this._urlToPathAndParams(url);
      if (parsedUrl) {
        const { path, params } = parsedUrl;
        const urlAction = Component.router.getActionForPathAndParams(
          path,
          params
        );
        if (urlAction) {
          !!process.env.REACT_NAV_LOGGING &&
            console.log('Applying Navigation Action for Initial URL:', url);
          action = urlAction;
          startupState = Component.router.getStateForAction(
            urlAction,
            startupState
          );
        }
      }
      if (startupState === this.state.nav) {
        return;
      }
      this.setState({ nav: startupState }, () => {
        _reactNavigationIsHydratingState = false;
        this._actionEventSubscribers.forEach(subscriber =>
          subscriber({
            type: 'action',
            action,
            state: this.state.nav,
            lastState: null,
          })
        );
      });
    }

    componentDidCatch(e, errorInfo) {
      if (_reactNavigationIsHydratingState) {
        _reactNavigationIsHydratingState = false;
        console.warn(
          'Uncaught exception while starting app from persisted navigation state! Trying to render again with a fresh navigation state..'
        );
        this.dispatch(NavigationActions.init());
      }
    }

    _persistNavigationState = async nav => {
      const { persistenceKey } = this.props;
      if (!persistenceKey) {
        return;
      }
      await AsyncStorage.setItem(persistenceKey, JSON.stringify(nav));
    };

    componentWillUnmount() {
      this._isMounted = false;
      Linking.removeEventListener('url', this._handleOpenURL);
      this.subs && this.subs.remove();

      if (this._isStateful()) {
        _statefulContainerCount--;
      }
    }

    // Per-tick temporary storage for state.nav

    dispatch = action => {
      if (this.props.navigation) {
        return this.props.navigation.dispatch(action);
      }
      this._nav = this._nav || this.state.nav;
      const oldNav = this._nav;
      invariant(oldNav, 'should be set in constructor if stateful');
      const nav = Component.router.getStateForAction(action, oldNav);
      const dispatchActionEvents = () => {
        this._actionEventSubscribers.forEach(subscriber =>
          subscriber({
            type: 'action',
            action,
            state: nav,
            lastState: oldNav,
          })
        );
      };
      if (nav && nav !== oldNav) {
        // Cache updates to state.nav during the tick to ensure that subsequent calls will not discard this change
        this._nav = nav;
        this.setState({ nav }, () => {
          this._onNavigationStateChange(oldNav, nav, action);
          dispatchActionEvents();
          this._persistNavigationState(nav);
        });
        return true;
      } else {
        dispatchActionEvents();
      }
      return false;
    };

    render() {
      let navigation = this.props.navigation;
      if (this._isStateful()) {
        const nav = this.state.nav;
        if (!nav) {
          return this._renderLoading();
        }
        if (!this._navigation || this._navigation.state !== nav) {
          this._navigation = {
            dispatch: this.dispatch,
            state: nav,
            addListener: (eventName, handler) => {
              if (eventName !== 'action') {
                return { remove: () => {} };
              }
              this._actionEventSubscribers.add(handler);
              return {
                remove: () => {
                  this._actionEventSubscribers.delete(handler);
                },
              };
            },
          };
        }
        navigation = this._navigation;
      }
      invariant(navigation, 'failed to get navigation');
      return <Component {...this.props} navigation={navigation} />;
    }
  }

  return withLifecyclePolyfill(NavigationContainer);
}
