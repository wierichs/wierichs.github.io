const inputField = document.getElementById('input-temp');
const fromUnitField = document.getElementById('input-unit');
const toUnitField = document.getElementById('output-unit');
const outputField = document.getElementById('output-temp');
const form = document.getElementById('converter');

function convertTemp(value, fromUnit, toUnit) {
	var baseKelvin = 0;
	var baseCelsius = 273.15;
	var baseFahrenheit = 273.15;
	var factorKelvin = 1;
	var factorCelsius = 1;
	var factorFahrenheit = (9 / 5);
	var offsetKelvin = 0;
	var offsetCelsius = 0;
	var offsetFahrenheit = 32;
	
  switch(fromUnit)
  {
	  case 'c':
		switch(toUnit)
		{
			case 'f':
				return (value + baseCelsius + offsetFahrenheit) * factorFahrenheit;
				break;				
			case 'k':
				return value + baseCelsius;
				break;
		}
		break;
	  case 'f':
		switch(toUnit)
		{
			case 'c':
				return (value + baseFahrenheit - offsetFahrenheit) * 1 / factorFahrenheit;
				break;
			case 'k':
				return (value - baseFahrenheit - offsetFahrenheit) * 1 / factorFahrenheit;
				break;				
		}
		break;
	  case 'k':
		switch(toUnit)
		{
			case 'c':
				return value + baseCelsius;
				break;
			case 'f':
				return (value + baseFahrenheit + offsetFahrenheit) * factorFahrenheit;
				break;				
		}
		break;
  }
/*  if (fromUnit === 'c') {
    if (toUnit === 'f') {
      return value * 9 / 5 + 32;
    } else if (toUnit === 'k') {
      return value + 273.15;
    }
    return value;
  }
  if (fromUnit === 'f') {
    if (toUnit === 'c') {
      return (value - 32) * 5 / 9;
    } else if (toUnit === 'k') {
      return (value + 459.67) * 5 / 9;
    }
    return value;
  }
  if (fromUnit === 'k') {
    if (toUnit === 'c') {
      return value - 273.15;
    } else if (toUnit === 'f') {
      return value * 9 / 5 - 459.67;
    }
    return value;
  } */
  throw new Error('Invalid unit');
}

form.addEventListener('input', () => {
  const inputTemp = parseFloat(inputField.value);
  const fromUnit = fromUnitField.value;
  const toUnit = toUnitField.value;

  const outputTemp = convertTemp(inputTemp, fromUnit, toUnit);
  outputField.value = (Math.round(outputTemp * 100) / 100) + ' ' + toUnit.toUpperCase();
});