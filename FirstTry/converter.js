const inputField = document.forms['converter']['input_temp'];
const fromUnitField = document.forms['converter']['input_unit'];
const toUnitField = document.forms['converter']['output_unit'];
const outputField = document.forms['converter']['output_temp'];
const form = document.forms['converter'];

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
				return value * 9 / 5 + 32;
				break;				
			case 'k':
				return value + 273.15;
				break;
		}
		break;
	  case 'f':
		switch(toUnit)
		{
			case 'c':
				return (value - 32) * 5 / 9;
				break;
			case 'k':
				return (value + 459.67) * 5 / 9;
				break;				
		}
		break;
	  case 'k':
		switch(toUnit)
		{
			case 'c':
				return value - 273.15;
				break;
			case 'f':
				return value * 9 / 5 - 459.67;
				break;				
		}
		break;
  }
  //throw new Error('Invalid unit');
  return value;
}

form.addEventListener('input', () => {
  const inputTemp = parseFloat(inputField.value);
  const fromUnit = fromUnitField.value;
  const toUnit = toUnitField.value;

  const outputTemp = convertTemp(inputTemp, fromUnit, toUnit);
  outputField.value = (Math.round(outputTemp * 100) / 100) + ' ' + toUnit.toUpperCase();
});