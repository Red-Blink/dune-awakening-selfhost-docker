using Mono.Cecil;
using Mono.Cecil.Cil;

if (args.Length != 2)
{
    Console.Error.WriteLine("usage: director-compat-patcher INPUT OUTPUT");
    return 2;
}

var resolver = new DefaultAssemblyResolver();
resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(args[0]))!);
using var assembly = AssemblyDefinition.ReadAssembly(args[0], new ReaderParameters
{
    AssemblyResolver = resolver,
});
var module = assembly.MainModule;

PatchGmeDispatch(module);
DowngradeExpectedUnconfiguredGmeLogs(module);
PatchTrustedTravelAuthentication(module);

assembly.Write(args[1]);
return 0;

static void PatchGmeDispatch(ModuleDefinition module)
{
    var calls = AllMethods(module)
        .SelectMany(method => method.HasBody
            ? method.Body.Instructions.Select(instruction => (method, instruction))
            : [])
        .Where(pair => pair.instruction.OpCode == OpCodes.Call
            && pair.instruction.Operand is MethodReference called
            && called.FullName.Contains("RmqGame::get_IsGmeConfigured", StringComparison.Ordinal))
        .ToList();

    if (calls.Count != 1)
    {
        throw new InvalidOperationException($"Expected one GME configuration guard, found {calls.Count}.");
    }

    var (method, call) = calls[0];
    var previous = call.Previous ?? throw new InvalidOperationException("GME guard has no receiver instruction.");
    if (previous.OpCode != OpCodes.Ldfld)
    {
        throw new InvalidOperationException($"Unexpected GME guard receiver in {method.FullName}: {previous.OpCode}.");
    }

    // Preserve instruction count while replacing `this.IsGmeConfigured` with true.
    previous.OpCode = OpCodes.Pop;
    previous.Operand = null;
    call.OpCode = OpCodes.Ldc_I4_1;
    call.Operand = null;
}

static void PatchTrustedTravelAuthentication(ModuleDefinition module)
{
    var type = module.GetType("BattlegroupDirector.Travel.ServerAuthenticator")
        ?? throw new InvalidOperationException("ServerAuthenticator type was not found.");
    var method = type.Methods.Single(candidate => candidate.Name == "IsRequestsPasswordOrTokenValid");
    var body = method.Body;
    var processor = body.GetILProcessor();

    var getPasswordCall = body.Instructions.Single(instruction =>
        instruction.OpCode == OpCodes.Callvirt
        && instruction.Operand is MethodReference called
        && called.Name == "Invoke"
        && called.DeclaringType.Name.Contains("GetServerLoginPasswordDelegate", StringComparison.Ordinal));
    var passwordStore = getPasswordCall.Next;
    if (passwordStore is null || !IsStoreLocal(passwordStore.OpCode))
    {
        throw new InvalidOperationException("Could not locate destination password local.");
    }

    var requestPasswordLocal = body.Variables[0];
    var destinationPasswordLocal = body.Variables[1];
    var resume = passwordStore.Next ?? throw new InvalidOperationException("Authentication method has no continuation.");
    var getFlow = module.GetType("BattlegroupDirector.Travel.TravelRequest")
        ?.Properties.Single(property => property.Name == "Flow").GetMethod
        ?? throw new InvalidOperationException("TravelRequest.Flow getter was not found.");
    var isNullOrEmpty = module.ImportReference(typeof(string).GetMethod(nameof(string.IsNullOrEmpty), [typeof(string)])!);

    var injected = new[]
    {
        processor.Create(OpCodes.Ldarg_1),
        processor.Create(OpCodes.Callvirt, getFlow),
        processor.Create(OpCodes.Ldc_I4_1),
        processor.Create(OpCodes.Bne_Un, resume),
        processor.Create(OpCodes.Ldloc, requestPasswordLocal),
        processor.Create(OpCodes.Call, isNullOrEmpty),
        processor.Create(OpCodes.Brfalse, resume),
        processor.Create(OpCodes.Ldloc, destinationPasswordLocal),
        processor.Create(OpCodes.Call, isNullOrEmpty),
        processor.Create(OpCodes.Brtrue, resume),
        processor.Create(OpCodes.Ldloc, destinationPasswordLocal),
        processor.Create(OpCodes.Stloc, requestPasswordLocal),
    };

    foreach (var instruction in injected)
    {
        processor.InsertBefore(resume, instruction);
    }
}

static void DowngradeExpectedUnconfiguredGmeLogs(ModuleDefinition module)
{
    string[] expectedMessages =
    [
        "GmeAuthTokenHandler is not configured",
        "The GmeAuthTokenHandlerDelegate returned an invalid response",
    ];

    foreach (var message in expectedMessages)
    {
        var messageInstruction = AllMethods(module)
            .Where(method => method.HasBody)
            .SelectMany(method => method.Body.Instructions)
            .Single(instruction => instruction.OpCode == OpCodes.Ldstr
                && string.Equals(instruction.Operand as string, message, StringComparison.Ordinal));
        var logCall = NextCall(messageInstruction)
            ?? throw new InvalidOperationException($"No log call follows expected GME message: {message}");
        var errorMethod = (MethodReference)logCall.Operand;
        if (errorMethod.DeclaringType.FullName != "Serilog.Log" || errorMethod.Name != "Error")
        {
            throw new InvalidOperationException($"Unexpected logger for GME message '{message}': {errorMethod.FullName}");
        }

        var debugMethod = errorMethod.DeclaringType.Resolve().Methods.Single(candidate =>
            candidate.Name == "Debug"
            && candidate.GenericParameters.Count == errorMethod.GenericParameters.Count
            && candidate.Parameters.Select(parameter => parameter.ParameterType.FullName)
                .SequenceEqual(errorMethod.Parameters.Select(parameter => parameter.ParameterType.FullName)));
        logCall.Operand = module.ImportReference(debugMethod);
    }
}

static IEnumerable<MethodDefinition> AllMethods(ModuleDefinition module)
{
    return module.Types.SelectMany(AllMethodsInType);
}

static IEnumerable<MethodDefinition> AllMethodsInType(TypeDefinition type)
{
    return type.Methods.Concat(type.NestedTypes.SelectMany(AllMethodsInType));
}

static bool IsStoreLocal(OpCode opCode)
{
    return opCode == OpCodes.Stloc
        || opCode == OpCodes.Stloc_S
        || opCode == OpCodes.Stloc_0
        || opCode == OpCodes.Stloc_1
        || opCode == OpCodes.Stloc_2
        || opCode == OpCodes.Stloc_3;
}

static Instruction? NextCall(Instruction instruction)
{
    for (var current = instruction.Next; current is not null; current = current.Next)
    {
        if ((current.OpCode == OpCodes.Call || current.OpCode == OpCodes.Callvirt)
            && current.Operand is MethodReference)
        {
            return current;
        }
    }
    return null;
}
