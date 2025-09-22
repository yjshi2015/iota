#[test_only]
module account_template::account_template_tests;

use account_template::account_template;
use iota::test_scenario;

#[test]
fun authenticator_not_set() {
    let test_sender = @0x0;
    let mut scenario_val = test_scenario::begin(test_sender);
    let scenario = &mut scenario_val;

    let ctx = test_scenario::ctx(scenario);

    let id = object::new(ctx);
    // let id = iota::test_scenario::new_object(scenario);

    // This will fail to compile with:
    //     71 │     iota::transfer::share_object(IOTAccount { id: uid });
    //    │                                  ^^^^^^^^^^^^^^^^^^^^^^
    //    │                                  │            │
    //    │                                  │            The UID must come directly from iota::object::new.  Or for tests, it can come from iota::test_scenario::new_object
    //    │                                  Invalid object creation without a newly created UID.
    // The issue is baffling, because we already have the same pattern which doesn't have the issue at:
    // examples/move/time_locked/tests/time_locked_tests.move
    // function create_time_locked_for_testing will call  time_locked::create(unlock_time, public_key, 
    // authenticator, ctx); which internally calls account_template::create_shared(id);
    // The only real difference between the two cases is that here the id was created in a test function.
    account_template::create_shared(id);

    test_scenario::end(scenario_val);
}

// --------------------------------------- Test Utilities ---------------------------------------

// fun create_authenticator_info_v1_for_testing(): AuthenticatorInfoV1 {
//     account::create_auth_info_v1_for_testing(
//         @0x1,
//         ascii::string(b"auth_info_v1"),
//         ascii::string(b"create"),
//     )
// }
