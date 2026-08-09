param(
  [string]$InputSourcePath = "",
  [string]$InputPayloadPath = ""
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSEdition -ne "Desktop") {
  throw "Run the Windows helper verifier with Windows PowerShell 5.1."
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = if ([string]::IsNullOrWhiteSpace($InputSourcePath)) {
  Join-Path $repositoryRoot "src\tools\windows-bash-supervisor-helper.cs"
} else { [IO.Path]::GetFullPath($InputSourcePath) }
$payloadPath = if ([string]::IsNullOrWhiteSpace($InputPayloadPath)) {
  Join-Path $repositoryRoot "src\tools\windows-bash-supervisor-reviewed-assembly.ts"
} else { [IO.Path]::GetFullPath($InputPayloadPath) }
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$buildRoot = [IO.Path]::GetFullPath((Join-Path $temporaryRoot (
  "pi-clone-supervisor-verification-" + [Guid]::NewGuid().ToString("N"))))
$bindingFlags =
  [Reflection.BindingFlags]::Public -bor
  [Reflection.BindingFlags]::NonPublic -bor
  [Reflection.BindingFlags]::Instance -bor
  [Reflection.BindingFlags]::Static -bor
  [Reflection.BindingFlags]::DeclaredOnly

function Format-Type([Type]$type) {
  if ($null -eq $type) { return $null }
  if ($type.IsGenericParameter) {
    $prefix = if ($null -eq $type.DeclaringMethod) { "!" } else { "!!" }
    return "$prefix$($type.GenericParameterPosition):$($type.Name)"
  }
  if ($type.IsByRef) { return "$(Format-Type $type.GetElementType())&" }
  if ($type.IsPointer) { return "$(Format-Type $type.GetElementType())*" }
  if ($type.IsArray) {
    return "$(Format-Type $type.GetElementType())[$(',' * ($type.GetArrayRank() - 1))]"
  }
  if ($type.IsGenericType) {
    $definition = $type.GetGenericTypeDefinition().FullName -replace
      '<PrivateImplementationDetails>\{[0-9A-Fa-f-]{36}\}',
      '<PrivateImplementationDetails>{MVID}'
    $arguments = @($type.GetGenericArguments() | ForEach-Object { Format-Type $_ })
    return "$definition[$($arguments -join ',')]"
  }
  return $type.FullName -replace
    '<PrivateImplementationDetails>\{[0-9A-Fa-f-]{36}\}',
    '<PrivateImplementationDetails>{MVID}'
}

function Format-Value($value) {
  if ($null -eq $value) { return "null" }
  if ($value -is [Type]) { return "type:$(Format-Type $value)" }
  if ($value -is [string]) { return "string:$value" }
  if ($value -is [char]) { return "char:$([int]$value)" }
  if ($value -is [bool]) { return "bool:$($value.ToString().ToLowerInvariant())" }
  if ($value -is [float]) {
    return "single:$($value.ToString('R', [Globalization.CultureInfo]::InvariantCulture))"
  }
  if ($value -is [double]) {
    return "double:$($value.ToString('R', [Globalization.CultureInfo]::InvariantCulture))"
  }
  if ($value -is [decimal]) {
    return "decimal:$($value.ToString([Globalization.CultureInfo]::InvariantCulture))"
  }
  if ($value -is [Array]) {
    return "array:[$(@($value | ForEach-Object { Format-Value $_ }) -join ',')]"
  }
  return "$($value.GetType().FullName):$([Convert]::ToString(
    $value,
    [Globalization.CultureInfo]::InvariantCulture))"
}

function Format-AttributeArgument(
  [Reflection.CustomAttributeTypedArgument]$argument
) {
  $value = $argument.Value
  if ($value -is [Collections.IEnumerable] -and $value -isnot [string]) {
    $items = @($value | ForEach-Object {
      Format-AttributeArgument ([Reflection.CustomAttributeTypedArgument]$_)
    })
    return "$(Format-Type $argument.ArgumentType)=[$($items -join ',')]"
  }
  return "$(Format-Type $argument.ArgumentType)=$(Format-Value $value)"
}

function Get-CustomAttributes($provider) {
  return @($provider.GetCustomAttributesData() | ForEach-Object {
    $attribute = $_
    $constructor = Format-Member $attribute.Constructor
    $constructorArguments = @($attribute.ConstructorArguments |
      ForEach-Object { Format-AttributeArgument $_ })
    $namedArguments = @($attribute.NamedArguments |
      ForEach-Object {
        "$($_.IsField):$($_.MemberName)=$(Format-AttributeArgument $_.TypedValue)"
      } | Sort-Object)
    "$($attribute.AttributeType.FullName)|$constructor|$($constructorArguments -join ';')|$($namedArguments -join ';')"
  } | Sort-Object)
}

function Format-Member([Reflection.MemberInfo]$member) {
  if ($null -eq $member) { return $null }
  if ($member -is [Type]) { return "type:$(Format-Type $member)" }
  if ($member -is [Reflection.FieldInfo]) {
    return "field:$(Format-Type $member.DeclaringType)::$($member.Name):$(Format-Type $member.FieldType)"
  }
  if ($member -is [Reflection.MethodBase]) {
    $parameters = @($member.GetParameters() |
      ForEach-Object { Format-Type $_.ParameterType })
    $generic = if ($member.IsGenericMethod) {
      "[$(@($member.GetGenericArguments() | ForEach-Object { Format-Type $_ }) -join ',')]"
    } else { "" }
    $returnType = if ($member -is [Reflection.MethodInfo]) {
      Format-Type $member.ReturnType
    } else { "void" }
    return "method:$(Format-Type $member.DeclaringType)::$($member.Name)$generic($($parameters -join ',')):$returnType"
  }
  return "$($member.MemberType):$(Format-Type $member.DeclaringType)::$($member.Name)"
}

function Get-GenericParameters([Reflection.MethodBase]$method) {
  if (!$method.IsGenericMethod) { return @() }
  return @($method.GetGenericArguments() | ForEach-Object {
    [ordered]@{
      name = $_.Name
      position = $_.GenericParameterPosition
      attributes = [int]$_.GenericParameterAttributes
      constraints = @($_.GetGenericParameterConstraints() |
        ForEach-Object { Format-Type $_ } | Sort-Object)
      customAttributes = Get-CustomAttributes $_
    }
  })
}

$script:OpCodes = @{}
foreach ($field in [Reflection.Emit.OpCodes].GetFields(
    [Reflection.BindingFlags]'Public,Static')) {
  $opcode = [Reflection.Emit.OpCode]$field.GetValue($null)
  $key = [uint16]($opcode.Value -band 0xffff)
  $script:OpCodes[$key] = $opcode
}

function Resolve-Token(
  [Reflection.Module]$module,
  [int]$token,
  [string]$operandType,
  [Type[]]$typeArguments,
  [Type[]]$methodArguments
) {
  switch ($operandType) {
    "InlineString" { return "string:$($module.ResolveString($token))" }
    "InlineField" {
      return Format-Member $module.ResolveField($token, $typeArguments, $methodArguments)
    }
    "InlineMethod" {
      return Format-Member $module.ResolveMethod($token, $typeArguments, $methodArguments)
    }
    "InlineType" {
      return "type:$(Format-Type $module.ResolveType($token, $typeArguments, $methodArguments))"
    }
    "InlineTok" {
      return Format-Member $module.ResolveMember($token, $typeArguments, $methodArguments)
    }
    "InlineSig" {
      return "signature:$([Convert]::ToBase64String($module.ResolveSignature($token)))"
    }
    default { throw "Unsupported metadata token operand $operandType." }
  }
}

function Get-NormalizedIl([Reflection.MethodBase]$method) {
  $body = $method.GetMethodBody()
  if ($null -eq $body) { return @() }
  $bytes = $body.GetILAsByteArray()
  $instructions = @()
  $offset = 0
  $typeArguments = if (
    $null -ne $method.DeclaringType -and
    $method.DeclaringType.IsGenericType
  ) {
    [Type[]]$method.DeclaringType.GetGenericArguments()
  } else { [Type[]]@() }
  $methodArguments = if ($method.IsGenericMethod) {
    [Type[]]$method.GetGenericArguments()
  } else { [Type[]]@() }

  while ($offset -lt $bytes.Length) {
    $instructionOffset = $offset
    $first = [uint16]$bytes[$offset]
    $offset += 1
    $key = if ($first -eq 0xfe) {
      $second = [uint16]$bytes[$offset]
      $offset += 1
      [uint16](0xfe00 -bor $second)
    } else { $first }
    $opcode = $script:OpCodes[$key]
    if ($null -eq $opcode) { throw "Unknown IL opcode at $instructionOffset." }
    $operandType = $opcode.OperandType.ToString()
    $operand = $null

    switch ($operandType) {
      "InlineNone" { }
      "ShortInlineI" {
        $operand = [int]$bytes[$offset]
        if ($operand -gt 127) { $operand -= 256 }
        $offset += 1
      }
      "InlineI" {
        $operand = [BitConverter]::ToInt32($bytes, $offset)
        $offset += 4
      }
      "InlineI8" {
        $operand = [BitConverter]::ToInt64($bytes, $offset)
        $offset += 8
      }
      "ShortInlineR" {
        $operand = [BitConverter]::ToSingle($bytes, $offset).ToString(
          'R', [Globalization.CultureInfo]::InvariantCulture)
        $offset += 4
      }
      "InlineR" {
        $operand = [BitConverter]::ToDouble($bytes, $offset).ToString(
          'R', [Globalization.CultureInfo]::InvariantCulture)
        $offset += 8
      }
      "ShortInlineVar" {
        $operand = [uint16]$bytes[$offset]
        $offset += 1
      }
      "InlineVar" {
        $operand = [BitConverter]::ToUInt16($bytes, $offset)
        $offset += 2
      }
      "ShortInlineBrTarget" {
        $delta = [int]$bytes[$offset]
        if ($delta -gt 127) { $delta -= 256 }
        $offset += 1
        $operand = $offset + $delta
      }
      "InlineBrTarget" {
        $delta = [BitConverter]::ToInt32($bytes, $offset)
        $offset += 4
        $operand = $offset + $delta
      }
      "InlineSwitch" {
        $count = [BitConverter]::ToInt32($bytes, $offset)
        $offset += 4
        $deltas = @()
        for ($index = 0; $index -lt $count; $index += 1) {
          $deltas += [BitConverter]::ToInt32($bytes, $offset)
          $offset += 4
        }
        $base = $offset
        $operand = @($deltas | ForEach-Object { $base + $_ })
      }
      { $_ -in @(
          "InlineString",
          "InlineField",
          "InlineMethod",
          "InlineType",
          "InlineTok",
          "InlineSig") } {
        $token = [BitConverter]::ToInt32($bytes, $offset)
        $offset += 4
        $operand = Resolve-Token $method.Module $token $operandType $typeArguments $methodArguments
      }
      default { throw "Unsupported IL operand type $operandType." }
    }

    $instructions += [ordered]@{
      offset = $instructionOffset
      opcode = $opcode.Name
      operand = $operand
    }
  }
  return $instructions
}

function Get-ParameterManifest([Reflection.ParameterInfo]$parameter) {
  $hasDefault = $parameter.HasDefaultValue
  return [ordered]@{
    position = $parameter.Position
    name = $parameter.Name
    type = Format-Type $parameter.ParameterType
    attributes = [int]$parameter.Attributes
    hasDefault = $hasDefault
    defaultValue = if ($hasDefault) { Format-Value $parameter.RawDefaultValue } else { $null }
    requiredCustomModifiers = @($parameter.GetRequiredCustomModifiers() |
      ForEach-Object { Format-Type $_ })
    optionalCustomModifiers = @($parameter.GetOptionalCustomModifiers() |
      ForEach-Object { Format-Type $_ })
    customAttributes = Get-CustomAttributes $parameter
  }
}

function Get-MethodManifest([Reflection.MethodBase]$method) {
  $body = $method.GetMethodBody()
  $pinvoke = if (($method.Attributes -band
      [Reflection.MethodAttributes]::PinvokeImpl) -ne 0) {
    $attribute = @($method.GetCustomAttributes(
      [Runtime.InteropServices.DllImportAttribute],
      $false))[0]
    [ordered]@{
      library = $attribute.Value
      entryPoint = $attribute.EntryPoint
      charSet = [int]$attribute.CharSet
      setLastError = $attribute.SetLastError
      exactSpelling = $attribute.ExactSpelling
      preserveSig = $attribute.PreserveSig
      callingConvention = [int]$attribute.CallingConvention
      bestFitMapping = $attribute.BestFitMapping
      throwOnUnmappableChar = $attribute.ThrowOnUnmappableChar
    }
  } else { $null }
  return [ordered]@{
    signature = Format-Member $method
    attributes = [int]$method.Attributes
    callingConvention = [int]$method.CallingConvention
    implementationAttributes = [int]$method.GetMethodImplementationFlags()
    genericParameters = Get-GenericParameters $method
    parameters = @($method.GetParameters() |
      ForEach-Object { Get-ParameterManifest $_ })
    returnParameter = if ($method -is [Reflection.MethodInfo]) {
      Get-ParameterManifest $method.ReturnParameter
    } else { $null }
    pinvoke = $pinvoke
    customAttributes = Get-CustomAttributes $method
    body = if ($null -eq $body) { $null } else {
      [ordered]@{
        initLocals = $body.InitLocals
        maxStack = $body.MaxStackSize
        locals = @($body.LocalVariables | ForEach-Object {
          [ordered]@{
            index = $_.LocalIndex
            type = Format-Type $_.LocalType
            pinned = $_.IsPinned
          }
        })
        exceptions = @($body.ExceptionHandlingClauses | ForEach-Object {
          [ordered]@{
            flags = [int]$_.Flags
            tryOffset = $_.TryOffset
            tryLength = $_.TryLength
            handlerOffset = $_.HandlerOffset
            handlerLength = $_.HandlerLength
            filterOffset = $_.FilterOffset
            catchType = Format-Type $_.CatchType
          }
        })
        il = Get-NormalizedIl $method
      }
    }
  }
}

function Get-FieldRvaBytes([Reflection.FieldInfo]$field) {
  if (($field.Attributes -band [Reflection.FieldAttributes]::HasFieldRVA) -eq 0) {
    return $null
  }
  $size = $field.FieldType.StructLayoutAttribute.Size
  if ($size -le 0) {
    throw "FieldRVA data has no declared storage size."
  }
  $bytes = [byte[]]::new($size)
  [Runtime.CompilerServices.RuntimeHelpers]::InitializeArray(
    $bytes,
    $field.FieldHandle)
  return [Convert]::ToBase64String($bytes)
}

function Get-TypeManifest([Type]$type) {
  $layout = $type.StructLayoutAttribute
  $declaredFields = @($type.GetFields($bindingFlags) |
    Sort-Object MetadataToken)
  $fieldManifests = @()
  for ($fieldIndex = 0; $fieldIndex -lt $declaredFields.Count; $fieldIndex += 1) {
    $field = $declaredFields[$fieldIndex]
    $fieldManifests += [ordered]@{
      declarationOrder = $fieldIndex
      name = $field.Name
      type = Format-Type $field.FieldType
      attributes = [int]$field.Attributes
      offset = if ($type.IsExplicitLayout -or $type.IsLayoutSequential) {
        [Runtime.InteropServices.Marshal]::OffsetOf(
          $type,
          $field.Name).ToInt64()
      } else { $null }
      fieldRvaBytes = Get-FieldRvaBytes $field
      constant = if ($field.IsLiteral) {
        Format-Value $field.GetRawConstantValue()
      } else { $null }
      requiredCustomModifiers = @($field.GetRequiredCustomModifiers() |
        ForEach-Object { Format-Type $_ })
      optionalCustomModifiers = @($field.GetOptionalCustomModifiers() |
        ForEach-Object { Format-Type $_ })
      customAttributes = Get-CustomAttributes $field
    }
  }
  $declaredMethods = @(
    $type.GetConstructors($bindingFlags) + $type.GetMethods($bindingFlags) |
      Sort-Object MetadataToken)
  $methodManifests = @()
  for ($methodIndex = 0; $methodIndex -lt $declaredMethods.Count; $methodIndex += 1) {
    $methodManifests += [ordered]@{
      declarationOrder = $methodIndex
      semantic = Get-MethodManifest $declaredMethods[$methodIndex]
    }
  }
  return [ordered]@{
    name = Format-Type $type
    attributes = [int]$type.Attributes
    baseType = Format-Type $type.BaseType
    interfaces = @($type.GetInterfaces() |
      ForEach-Object { Format-Type $_ } | Sort-Object)
    layout = if ($null -eq $layout) { $null } else {
      [ordered]@{
        value = [int]$layout.Value
        pack = $layout.Pack
        size = $layout.Size
        charSet = [int]$layout.CharSet
      }
    }
    customAttributes = Get-CustomAttributes $type
    fields = $fieldManifests
    methods = $methodManifests
    properties = @($type.GetProperties($bindingFlags) |
      Sort-Object Name | ForEach-Object {
        [ordered]@{
          name = $_.Name
          attributes = [int]$_.Attributes
          type = Format-Type $_.PropertyType
          indexParameters = @($_.GetIndexParameters() |
            ForEach-Object { Get-ParameterManifest $_ })
          getter = Format-Member $_.GetGetMethod($true)
          setter = Format-Member $_.GetSetMethod($true)
          customAttributes = Get-CustomAttributes $_
        }
      })
    events = @($type.GetEvents($bindingFlags) | Sort-Object Name |
      ForEach-Object {
        [ordered]@{
          name = $_.Name
          attributes = [int]$_.Attributes
          handlerType = Format-Type $_.EventHandlerType
          add = Format-Member $_.GetAddMethod($true)
          remove = Format-Member $_.GetRemoveMethod($true)
          raise = Format-Member $_.GetRaiseMethod($true)
          customAttributes = Get-CustomAttributes $_
        }
      })
  }
}

function Assert-ByteRange(
  [byte[]]$bytes,
  [long]$offset,
  [long]$length,
  [string]$label
) {
  if (
    $offset -lt 0 -or
    $length -lt 0 -or
    $offset -gt $bytes.LongLength -or
    $length -gt ($bytes.LongLength - $offset) -or
    $offset -gt [int]::MaxValue
  ) {
    throw "Invalid $label range in reviewed helper PE image."
  }
}

function Read-PeUInt16([byte[]]$bytes, [long]$offset, [string]$label) {
  Assert-ByteRange $bytes $offset 2 $label
  return [BitConverter]::ToUInt16($bytes, [int]$offset)
}

function Read-PeUInt32([byte[]]$bytes, [long]$offset, [string]$label) {
  Assert-ByteRange $bytes $offset 4 $label
  return [BitConverter]::ToUInt32($bytes, [int]$offset)
}

function Convert-PeRvaToFileOffset(
  [byte[]]$bytes,
  [uint32]$rva,
  [uint32]$length,
  [long]$sectionTableOffset,
  [uint16]$sectionCount,
  [uint32]$sizeOfHeaders
) {
  $rvaEnd = [uint64]$rva + [uint64]$length
  if ($rvaEnd -le [uint64]$sizeOfHeaders) {
    Assert-ByteRange $bytes $rva $length "header RVA"
    return [long]$rva
  }

  for ($index = 0; $index -lt $sectionCount; $index += 1) {
    $sectionOffset = $sectionTableOffset + (40 * $index)
    $virtualSize = Read-PeUInt32 $bytes ($sectionOffset + 8) "section virtual size"
    $virtualAddress = Read-PeUInt32 $bytes ($sectionOffset + 12) "section RVA"
    $rawSize = Read-PeUInt32 $bytes ($sectionOffset + 16) "section raw size"
    $rawOffset = Read-PeUInt32 $bytes ($sectionOffset + 20) "section raw offset"
    $mappedSize = [Math]::Max([uint64]$virtualSize, [uint64]$rawSize)
    $sectionEnd = [uint64]$virtualAddress + $mappedSize

    if (
      [uint64]$rva -ge [uint64]$virtualAddress -and
      $rvaEnd -le $sectionEnd
    ) {
      $delta = [uint64]$rva - [uint64]$virtualAddress
      if (($delta + [uint64]$length) -gt [uint64]$rawSize) {
        throw "Reviewed helper CLR header is outside section raw data."
      }
      $fileOffset = [uint64]$rawOffset + $delta
      if ($fileOffset -gt [int]::MaxValue) {
        throw "Reviewed helper CLR header file offset is too large."
      }
      Assert-ByteRange $bytes ([long]$fileOffset) $length "CLR header"
      return [long]$fileOffset
    }
  }

  throw "Reviewed helper CLR header RVA is not mapped by a PE section."
}

function Get-PeHeaderManifest([byte[]]$bytes) {
  Assert-ByteRange $bytes 0 64 "DOS header"
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  Assert-ByteRange $bytes $peOffset 24 "PE signature and COFF header"
  if ((Read-PeUInt32 $bytes $peOffset "PE signature") -ne 0x00004550) {
    throw "Reviewed helper does not have a PE signature."
  }

  $coffOffset = $peOffset + 4
  $sectionCount = Read-PeUInt16 $bytes ($coffOffset + 2) "COFF section count"
  $optionalHeaderSize = Read-PeUInt16 $bytes ($coffOffset + 16) "optional header size"
  $optionalHeaderOffset = $coffOffset + 20
  Assert-ByteRange $bytes $optionalHeaderOffset $optionalHeaderSize "optional header"
  $optionalMagic = Read-PeUInt16 $bytes $optionalHeaderOffset "optional header magic"
  if ($optionalMagic -eq 0x10b) {
    $dataDirectoryOffset = $optionalHeaderOffset + 96
    $directoryCountOffset = $optionalHeaderOffset + 92
  } elseif ($optionalMagic -eq 0x20b) {
    $dataDirectoryOffset = $optionalHeaderOffset + 112
    $directoryCountOffset = $optionalHeaderOffset + 108
  } else {
    throw "Reviewed helper has an unsupported PE optional header."
  }

  $directoryCount = Read-PeUInt32 $bytes $directoryCountOffset "data directory count"
  if ($directoryCount -lt 15) {
    throw "Reviewed helper has no CLR data directory."
  }
  Assert-ByteRange $bytes $dataDirectoryOffset (15 * 8) "PE data directories"

  $sectionTableOffset = $optionalHeaderOffset + $optionalHeaderSize
  $headerLength = $sectionTableOffset + (40 * $sectionCount)
  Assert-ByteRange $bytes 0 $headerLength "PE headers and section table"
  $normalizedHeaders = New-Object byte[] ([int]$headerLength)
  [Array]::Copy($bytes, 0, $normalizedHeaders, 0, [int]$headerLength)
  # The source compiler legitimately varies the COFF timestamp.
  [Array]::Clear($normalizedHeaders, [int]($coffOffset + 4), 4)

  $clrDirectoryOffset = $dataDirectoryOffset + (14 * 8)
  $clrRva = Read-PeUInt32 $bytes $clrDirectoryOffset "CLR header RVA"
  $clrDirectorySize = Read-PeUInt32 $bytes ($clrDirectoryOffset + 4) "CLR header size"
  if ($clrDirectorySize -lt 72) {
    throw "Reviewed helper CLR header is incomplete."
  }
  $sizeOfHeaders = Read-PeUInt32 $bytes ($optionalHeaderOffset + 60) "size of headers"
  $clrOffset = Convert-PeRvaToFileOffset `
    $bytes $clrRva 72 $sectionTableOffset $sectionCount $sizeOfHeaders
  $clrHeader = New-Object byte[] 72
  [Array]::Copy($bytes, [int]$clrOffset, $clrHeader, 0, 72)

  return [ordered]@{
    fileLength = $bytes.LongLength
    normalizedPeHeaders = [Convert]::ToBase64String($normalizedHeaders)
    clrHeader = [Convert]::ToBase64String($clrHeader)
  }
}

function Find-ByteSequenceOffsets([byte[]]$bytes, [byte[]]$sequence) {
  if ($sequence.Length -eq 0) {
    throw "Cannot locate an empty sequence in the reviewed helper image."
  }

  for (
    $offset = 0;
    $offset -le ($bytes.Length - $sequence.Length);
    $offset += 1
  ) {
    $matches = $true
    for ($index = 0; $index -lt $sequence.Length; $index += 1) {
      if ($bytes[$offset + $index] -ne $sequence[$index]) {
        $matches = $false
        break
      }
    }
    if ($matches) { Write-Output $offset }
  }
}

function Get-NormalizedWholePeImage(
  [byte[]]$bytes,
  [Reflection.Assembly]$assembly
) {
  $normalized = New-Object byte[] $bytes.Length
  [Array]::Copy($bytes, 0, $normalized, 0, $bytes.Length)

  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  Assert-ByteRange $bytes $peOffset 24 "PE signature and COFF header"
  if ((Read-PeUInt32 $bytes $peOffset "PE signature") -ne 0x00004550) {
    throw "Reviewed helper does not have a PE signature."
  }
  # Windows PowerShell 5.1's compiler varies this four-byte build timestamp.
  [Array]::Clear($normalized, [int]($peOffset + 8), 4)

  $mvid = $assembly.ManifestModule.ModuleVersionId
  $mvidBytes = $mvid.ToByteArray()
  $mvidOffsets = @(Find-ByteSequenceOffsets $bytes $mvidBytes)
  if ($mvidOffsets.Count -ne 1) {
    throw "Reviewed helper image must contain exactly one MVID GUID value."
  }
  [Array]::Clear($normalized, [int]$mvidOffsets[0], $mvidBytes.Length)

  $privateTypes = @($assembly.GetTypes() | Where-Object {
    $_.FullName -match '^<PrivateImplementationDetails>\{[0-9A-Fa-f-]{36}\}$'
  })
  if ($privateTypes.Count -gt 1) {
    throw "Reviewed helper has multiple MVID-derived private implementation types."
  }
  if ($privateTypes.Count -eq 1) {
    $privatePrefix = '<PrivateImplementationDetails>{'
    $expectedPrivateName =
      "$privatePrefix$($mvid.ToString('D').ToUpperInvariant())}"
    if (![string]::Equals(
        $privateTypes[0].FullName,
        $expectedPrivateName,
        [StringComparison]::Ordinal)) {
      throw "Reviewed helper private implementation type is not MVID-derived."
    }
    $privateNameBytes = [Text.Encoding]::ASCII.GetBytes($expectedPrivateName)
    $privateNameOffsets = @(
      Find-ByteSequenceOffsets $bytes $privateNameBytes
    )
    if ($privateNameOffsets.Count -ne 1) {
      throw "Reviewed helper image must contain exactly one MVID-derived private type name."
    }
    [Array]::Clear(
      $normalized,
      [int]($privateNameOffsets[0] + $privatePrefix.Length),
      36)
  }

  return [Convert]::ToBase64String($normalized)
}

function Get-AssemblyManifest([Reflection.Assembly]$assembly) {
  $resources = @($assembly.GetManifestResourceNames() | Sort-Object |
    ForEach-Object {
      $stream = $assembly.GetManifestResourceStream($_)
      try {
        $bytes = [byte[]]::new($stream.Length)
        [void]$stream.Read($bytes, 0, $bytes.Length)
        [ordered]@{ name = $_; bytes = [Convert]::ToBase64String($bytes) }
      } finally {
        if ($null -ne $stream) { $stream.Dispose() }
      }
    })
  $globalFields = @($assembly.ManifestModule.GetFields($bindingFlags) |
    Sort-Object MetadataToken)
  $globalFieldManifests = @()
  for ($fieldIndex = 0; $fieldIndex -lt $globalFields.Count; $fieldIndex += 1) {
    $field = $globalFields[$fieldIndex]
    $globalFieldManifests += [ordered]@{
      declarationOrder = $fieldIndex
      name = $field.Name
      type = Format-Type $field.FieldType
      attributes = [int]$field.Attributes
      fieldRvaBytes = Get-FieldRvaBytes $field
      constant = if ($field.IsLiteral) {
        Format-Value $field.GetRawConstantValue()
      } else { $null }
      customAttributes = Get-CustomAttributes $field
    }
  }
  $globalMethods = @($assembly.ManifestModule.GetMethods($bindingFlags) |
    Sort-Object MetadataToken)
  $globalMethodManifests = @()
  for ($methodIndex = 0; $methodIndex -lt $globalMethods.Count; $methodIndex += 1) {
    $globalMethodManifests += [ordered]@{
      declarationOrder = $methodIndex
      semantic = Get-MethodManifest $globalMethods[$methodIndex]
    }
  }
  return [ordered]@{
    identity = $assembly.GetName().FullName
    entryPoint = Format-Member $assembly.EntryPoint
    references = @($assembly.GetReferencedAssemblies() |
      ForEach-Object { $_.FullName } | Sort-Object)
    customAttributes = Get-CustomAttributes $assembly
    module = [ordered]@{
      name = $assembly.ManifestModule.Name
      customAttributes = Get-CustomAttributes $assembly.ManifestModule
      globalFields = $globalFieldManifests
      globalMethods = $globalMethodManifests
    }
    resources = $resources
    types = @($assembly.GetTypes() | Sort-Object FullName |
      ForEach-Object { Get-TypeManifest $_ })
  }
}

[void][IO.Directory]::CreateDirectory($buildRoot)
try {
  $freshPath = Join-Path $buildRoot "PiCloneWindowsJobSupervisor.dll"
  Add-Type -Path $sourcePath -OutputAssembly $freshPath -OutputType Library

  $payloadText = [IO.File]::ReadAllText($payloadPath, [Text.Encoding]::UTF8)
  $payloadMatch = [regex]::Match(
    $payloadText,
    ('\A// Generated only from windows-bash-supervisor-helper\.cs by Windows PowerShell 5\.1\.\r?\n' +
      '// CI recompiles the source and compares a complete normalized semantic manifest\.\r?\n' +
      'export const WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_SHA256 =\r?\n' +
      '  "(?<sha>[0-9a-f]{64})";\r?\n\r?\n' +
      'export const WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_BASE64 = \[\r?\n' +
      '(?<chunks>(?:  "[A-Za-z0-9+/=]+",\r?\n)+)' +
      '\]\.join\(""\);\r?\n?\z'),
    [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (!$payloadMatch.Success) {
    throw "Reviewed helper payload does not match the one canonical generated-file grammar."
  }
  $chunks = @([regex]::Matches(
    $payloadMatch.Groups['chunks'].Value,
    '"(?<chunk>[A-Za-z0-9+/=]+)"') | ForEach-Object {
      $_.Groups['chunk'].Value
    })
  if ($chunks.Count -eq 0) { throw "Reviewed helper payload is empty." }

  $committedBase64 = $chunks -join ''
  $committedBytes = [Convert]::FromBase64String($committedBase64)
  if (![string]::Equals(
      [Convert]::ToBase64String($committedBytes),
      $committedBase64,
      [StringComparison]::Ordinal)) {
    throw "Reviewed helper payload is not canonical Base64."
  }
  $payloadHash = [Security.Cryptography.SHA256]::Create()
  try {
    $actualPayloadSha = [BitConverter]::ToString(
      $payloadHash.ComputeHash($committedBytes)
    ).Replace('-', '').ToLowerInvariant()
  } finally {
    $payloadHash.Dispose()
  }
  if (![string]::Equals(
      $actualPayloadSha,
      $payloadMatch.Groups['sha'].Value,
      [StringComparison]::Ordinal)) {
    throw "Reviewed helper payload digest does not bind the exported assembly."
  }
  $freshBytes = [IO.File]::ReadAllBytes($freshPath)
  $committedPeManifest = Get-PeHeaderManifest $committedBytes |
    ConvertTo-Json -Depth 20 -Compress
  $freshPeManifest = Get-PeHeaderManifest $freshBytes |
    ConvertTo-Json -Depth 20 -Compress
  if (![string]::Equals(
      $committedPeManifest,
      $freshPeManifest,
      [StringComparison]::Ordinal)) {
    throw "Reviewed helper PE/COFF/CLR header manifest differs from source."
  }
  $committedAssembly = [Reflection.Assembly]::Load($committedBytes)
  $freshAssembly = [Reflection.Assembly]::Load($freshBytes)
  $committedWholeImage = Get-NormalizedWholePeImage `
    $committedBytes $committedAssembly
  $freshWholeImage = Get-NormalizedWholePeImage $freshBytes $freshAssembly
  if (![string]::Equals(
      $committedWholeImage,
      $freshWholeImage,
      [StringComparison]::Ordinal)) {
    throw "Reviewed helper normalized whole PE image differs from source."
  }
  $committedManifest = Get-AssemblyManifest $committedAssembly |
    ConvertTo-Json -Depth 100 -Compress
  $freshManifest = Get-AssemblyManifest $freshAssembly |
    ConvertTo-Json -Depth 100 -Compress

  if (![string]::Equals(
      $committedManifest,
      $freshManifest,
      [StringComparison]::Ordinal)) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
      $committedHash = [BitConverter]::ToString($hash.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($committedManifest))).Replace('-', '')
      $freshHash = [BitConverter]::ToString($hash.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($freshManifest))).Replace('-', '')
    } finally {
      $hash.Dispose()
    }
    $differenceOffset = 0
    $sharedLength = [Math]::Min(
      $committedManifest.Length,
      $freshManifest.Length)
    while (
      $differenceOffset -lt $sharedLength -and
      $committedManifest[$differenceOffset] -eq $freshManifest[$differenceOffset]
    ) {
      $differenceOffset += 1
    }
    $committedTail = $committedManifest.Substring(
      $differenceOffset,
      [Math]::Min(240, $committedManifest.Length - $differenceOffset))
    $freshTail = $freshManifest.Substring(
      $differenceOffset,
      [Math]::Min(240, $freshManifest.Length - $differenceOffset))
    [Console]::Error.WriteLine(
      "First semantic difference at $differenceOffset; committed=$committedTail")
    [Console]::Error.WriteLine("fresh=$freshTail")
    throw "Reviewed helper semantic manifest differs from source (committed=$committedHash fresh=$freshHash)."
  }

  Write-Output "Reviewed Windows helper matches the complete normalized source manifest."
} finally {
  $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
  if (!$resolvedBuildRoot.StartsWith(
      $temporaryRoot,
      [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a verifier directory outside the temporary root."
  }
  Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
}
